const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const si = require('systeminformation');
const cors = require('cors');
const { spawn } = require('child_process');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const archiver = require('archiver');
const session = require('express-session');
const multer = require('multer');
const unzipper = require('unzipper');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Multer storage
const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, req.body.dest || process.cwd()),
        filename: (req, file, cb) => cb(null, file.originalname)
    })
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Session Configuration
app.use(session({
  secret: 'optinode-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Auth Middleware
const checkAuth = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Não autorizado' });
  }
};

// Auth Routes
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// Resource History
let resourceHistory = [];
const MAX_HISTORY = 60;

// Set shell based on OS (UTF-8 by default for Windows)
const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
const shellArgs = process.platform === 'win32' 
  ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '$OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 >$null; powershell.exe -NoLogo -NoProfile'] 
  : [];

// Get static info once on startup
let staticData = {};

async function getStaticData() {
  const [os, cpu, graphics, mem, baseboard] = await Promise.all([
    si.osInfo(),
    si.cpu(),
    si.graphics(),
    si.mem(),
    si.baseboard()
  ]);

  staticData = {
    hostname: os.hostname,
    distro: os.distro,
    release: os.release,
    cpuModel: cpu.brand,
    cpuCores: cpu.cores,
    gpu: graphics.controllers.map(g => g.model).join(', '),
    totalRam: Math.round(mem.total / (1024 * 1024 * 1024)) + ' GB',
    motherboard: baseboard.model
  };
  return staticData;
}

// Function to get dynamic data
async function getDynamicData() {
  const [load, mem, fs] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize()
  ]);

  const data = {
    cpuUsage: Math.round(load.currentLoad),
    ramUsed: Math.round(mem.active / (1024 * 1024 * 1024) * 100) / 100, // GB
    ramPercentage: Math.round((mem.active / mem.total) * 100),
    timestamp: new Date().toLocaleTimeString(),
    storage: fs.map(f => ({
      mount: f.mount,
      size: (f.size / (1024 * 1024 * 1024)).toFixed(2),
      used: (f.used / (1024 * 1024 * 1024)).toFixed(2),
      use: f.use
    })).filter(f => f.size > 1)
  };

  resourceHistory.push(data);
  if (resourceHistory.length > MAX_HISTORY) resourceHistory.shift();
  
  return { ...data, history: resourceHistory };
}

// File system API
app.get('/api/files', checkAuth, async (req, res) => {
  try {
    const requestedPath = req.query.path || process.cwd();
    const resolvedPath = path.resolve(requestedPath);
    const entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
    
    const fileList = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(resolvedPath, entry.name);
      let size = 0, birthtime = '';
      try {
        const stats = await fsPromises.stat(entryPath);
        size = stats.size;
        birthtime = stats.birthtime;
      } catch (e) {}
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: (size / (1024 * 1024)).toFixed(2) + ' MB',
        path: entryPath,
        birthtime
      };
    }));
    
    res.json({
      currentPath: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      files: fileList.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name))
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/file-content', checkAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    const stats = await fsPromises.stat(filePath);
    if (stats.size > 1024 * 1024) return res.status(400).json({ error: "Arquivo muito grande (>1MB)." });
    const content = await fsPromises.readFile(filePath, 'utf8');
    res.json({ content });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/save-file', checkAuth, async (req, res) => {
  try {
    const { path, content } = req.body;
    await fsPromises.writeFile(path, content, 'utf8');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/rename', checkAuth, async (req, res) => {
  try {
    const { oldPath, newName } = req.body;
    const newPath = path.join(path.dirname(oldPath), newName);
    await fsPromises.rename(oldPath, newPath);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/delete', checkAuth, async (req, res) => {
  try {
    await fsPromises.rm(req.query.path, { recursive: true, force: true });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/create-folder', checkAuth, async (req, res) => {
  try {
    await fsPromises.mkdir(path.join(req.body.currentPath, req.body.folderName), { recursive: true });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/create-file', checkAuth, async (req, res) => {
  try {
    await fsPromises.writeFile(path.join(req.body.currentPath, req.body.fileName), '');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/compress', checkAuth, (req, res) => {
  const { targetPath } = req.body;
  const zipPath = `${targetPath}.zip`;
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', () => res.json({ success: true }));
  archive.on('error', (err) => res.status(500).json({ error: err.message }));
  archive.pipe(output);
  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) archive.directory(targetPath, path.basename(targetPath));
  else archive.file(targetPath, { name: path.basename(targetPath) });
  archive.finalize();
});

app.get('/api/processes', checkAuth, async (req, res) => {
  try {
    const data = await si.processes();
    const list = data.list.sort((a, b) => b.cpu - a.cpu).slice(0, 40).map(p => ({
      pid: p.pid, name: p.name, cpu: p.cpu.toFixed(1), mem: p.mem.toFixed(1), user: p.user, state: p.state
    }));
    res.json(list);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/kill-process', checkAuth, async (req, res) => {
  try {
    const { pid } = req.body;
    if (process.platform === 'win32') {
      require('child_process').exec(`taskkill /F /PID ${pid}`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    } else {
      process.kill(pid, 'SIGKILL');
      res.json({ success: true });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Download API
app.get('/api/download', checkAuth, (req, res) => {
  const filePath = req.query.path;
  res.download(filePath);
});

// Upload API
app.post('/api/upload', checkAuth, upload.single('file'), (req, res) => {
  res.json({ success: true });
});

// Unzip API
app.post('/api/unzip', checkAuth, async (req, res) => {
  try {
    const { zipPath } = req.body;
    const dest = path.dirname(zipPath);
    const directory = await unzipper.Open.file(zipPath);
    await directory.extract({ path: dest });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// System Controls
app.post('/api/system/reboot', checkAuth, (req, res) => {
  const cmd = process.platform === 'win32' ? 'shutdown /r /t 0' : 'reboot';
  require('child_process').exec(cmd);
  res.json({ success: true });
});

app.post('/api/system/shutdown', checkAuth, (req, res) => {
  const cmd = process.platform === 'win32' ? 'shutdown /s /t 0' : 'shutdown -h now';
  require('child_process').exec(cmd);
  res.json({ success: true });
});

io.on('connection', async (socket) => {
  console.log('Client connected');
  
  // Terminal Spawn with real PTY
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });

  ptyProcess.on('data', (data) => {
    socket.emit('terminal-output', data);
  });

  socket.on('terminal-input', (data) => {
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  socket.on('terminal-resize', (size) => {
    if (ptyProcess) {
      ptyProcess.resize(size.cols, size.rows);
    }
  });

  // Send static data immediately
  if (Object.keys(staticData).length === 0) {
    await getStaticData();
  }
  socket.emit('static_data', staticData);

  // Start telemetry polling
  const telemetryInterval = setInterval(async () => {
    const dynamicData = await getDynamicData();
    socket.emit('dynamic_data', dynamicData);
  }, 2000);

  socket.on('disconnect', () => {
    clearInterval(telemetryInterval);
    if (ptyProcess) ptyProcess.kill();
    console.log('Client disconnected');
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
