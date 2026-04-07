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
const mysql = require('mysql2/promise');

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

// MySQL Universal Management Logic
const getMySQLPaths = () => {
  if (process.platform === 'win32') {
    return {
      bin: 'C:\\xampp\\mysql\\bin\\mysqld.exe',
      config: 'C:\\xampp\\mysql\\bin\\my.ini',
      phpmyadmin: 'http://localhost/phpmyadmin/'
    };
  }
  return {
    bin: '/usr/sbin/mysqld',
    config: '/etc/mysql/mysql.conf.d/mysqld.cnf',
    phpmyadmin: '/phpmyadmin/'
  };
};

const getApachePaths = () => {
  if (process.platform === 'win32') {
    return {
      bin: 'C:\\xampp\\apache\\bin\\httpd.exe',
      config: 'C:\\xampp\\apache\\conf\\httpd.conf'
    };
  }
  return {
    bin: '/usr/sbin/apache2',
    config: '/etc/apache2/apache2.conf'
  };
};

app.get('/api/mysql/status', checkAuth, async (req, res) => {
  const paths = getMySQLPaths();
  const exists = fs.existsSync(paths.bin);
  let port = 3306;
  let remoteAccess = false;

  if (exists && fs.existsSync(paths.config)) {
    const content = await fsPromises.readFile(paths.config, 'utf8');
    // Match port in [mysqld] section or first occurrence
    const portMatch = content.match(/port\s*=\s*(\d+)/);
    if (portMatch) port = parseInt(portMatch[1]);
    remoteAccess = !content.includes('#bind-address') || content.includes('0.0.0.0');
  }

  // Try to connect to check if it's running
  let running = false;
  try {
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: port, user: 'root' });
    await conn.end();
    running = true;
  } catch (e) {}

  res.json({ 
    installed: exists, 
    running, 
    port, 
    remoteAccess,
    path: paths.bin,
    phpmyadmin: paths.phpmyadmin
  });
});

app.post('/api/mysql/apply-config', checkAuth, async (req, res) => {
  try {
    const paths = getMySQLPaths();
    if (!fs.existsSync(paths.config)) return res.status(404).json({ error: 'Configuração não encontrada' });

    let content = await fsPromises.readFile(paths.config, 'utf8');
    
    // Change port everywhere to be sure
    content = content.replace(/port\s*=\s*\d+/g, 'port=3165');
    
    // Enable remote access
    if (content.includes('bind-address')) {
      content = content.replace(/^bind-address\s*=.+/gm, '#bind-address = 0.0.0.0');
    } else {
      content = content.replace(/\[mysqld\]/g, '[mysqld]\nbind-address = 0.0.0.0');
    }

    await fsPromises.writeFile(paths.config, content);
    res.json({ success: true, message: 'Configuração aplicada com sucesso (Porta 3165).' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/mysql/start', checkAuth, async (req, res) => {
  try {
    const paths = getMySQLPaths();
    if (!fs.existsSync(paths.bin)) return res.status(404).json({ error: 'Binário não encontrado' });

    if (process.platform === 'win32') {
      // KILL FIRST to avoid "ibdata1 locked" issues
      require('child_process').exec('taskkill /F /IM mysqld.exe /T', () => {
        const mysqlCmd = `"${paths.bin}" --defaults-file="${paths.config}" --standalone`;
        require('child_process').exec(mysqlCmd, (err) => {
          if (err) console.error("MySQL Spawn Error:", err);
        });
      });
      // Wait a bit for it to start
      setTimeout(() => res.json({ success: true }), 3000);
    } else {
      require('child_process').exec('sudo systemctl start mysql', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/mysql/stop', checkAuth, async (req, res) => {
  try {
    if (process.platform === 'win32') {
      require('child_process').exec('taskkill /F /IM mysqld.exe /T', (err) => {
        if (err) return res.status(500).json({ error: 'Erro ao parar MySQL' });
        res.json({ success: true });
      });
    } else {
      require('child_process').exec('sudo systemctl stop mysql', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/mysql/databases', checkAuth, async (req, res) => {
  try {
    const statusRes = await fetch(`http://localhost:3000/api/mysql/status`, { headers: { cookie: req.headers.cookie } });
    const status = await statusRes.json();
    
    const connection = await mysql.createConnection({ host: '127.0.0.1', port: status.port, user: 'root' });
    const [rows] = await connection.query("SHOW DATABASES WHERE `Database` NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys', 'phpmyadmin')");
    
    const dbs = await Promise.all(rows.map(async (r) => {
        const dbName = r.Database;
        const [users] = await connection.query(`SELECT DISTINCT User FROM mysql.db WHERE \`Db\` = ?`, [dbName]);
        return { name: dbName, user: users.map(u => u.User).join(', ') || 'root' };
    }));

    await connection.end();
    res.json(dbs);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/mysql/create', checkAuth, async (req, res) => {
  const { dbName, username, password } = req.body;
  if (!dbName || !username || !password) return res.status(400).json({ error: 'Dados incompletos' });

  try {
    const statusRes = await fetch(`http://localhost:3000/api/mysql/status`, { headers: { cookie: req.headers.cookie } });
    const status = await statusRes.json();

    const connection = await mysql.createConnection({ host: '127.0.0.1', port: status.port, user: 'root' });
    
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${password}'`);
    await connection.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%'`);
    await connection.query(`FLUSH PRIVILEGES`);

    await connection.end();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/mysql/delete', checkAuth, async (req, res) => {
  const { dbName } = req.body;
  if (!dbName) return res.status(400).json({ error: 'Nome do banco não informado' });

  try {
    const statusRes = await fetch(`http://localhost:3000/api/mysql/status`, { headers: { cookie: req.headers.cookie } });
    const status = await statusRes.json();

    const connection = await mysql.createConnection({ host: '127.0.0.1', port: status.port, user: 'root' });
    await connection.query(`DROP DATABASE \`${dbName}\``);
    await connection.end();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/apache/status', checkAuth, async (req, res) => {
  const paths = getApachePaths();
  const exists = fs.existsSync(paths.bin);
  let running = false;
  
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'netstat -ano | findstr :3136' : 'lsof -i :3136';
    const output = execSync(cmd).toString();
    if (output.includes('LISTENING') || output.includes('httpd') || output.includes('LISTEN')) running = true;
  } catch (e) {}

  res.json({ installed: exists, running });
});

app.post('/api/apache/start', checkAuth, async (req, res) => {
  try {
    const paths = getApachePaths();
    if (!fs.existsSync(paths.bin)) return res.status(404).json({ error: 'Apache não encontrado' });

    if (process.platform === 'win32') {
      // KILL FIRST
      require('child_process').exec('taskkill /F /IM httpd.exe /T', () => {
        require('child_process').exec(`"${paths.bin}"`, (err) => {
          if (err) console.error("Apache Spawn Error:", err);
        });
      });
      setTimeout(() => res.json({ success: true }), 2000);
    } else {
      require('child_process').exec('sudo systemctl start apache2', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/apache/stop', checkAuth, async (req, res) => {
  try {
    if (process.platform === 'win32') {
      require('child_process').exec('taskkill /F /IM httpd.exe /T', (err) => {
        if (err) return res.status(500).json({ error: 'Erro ao parar Apache' });
        res.json({ success: true });
      });
    } else {
      require('child_process').exec('sudo systemctl stop apache2', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function autoStartServices() {
  console.log('[AUTO] Verificando serviços no boot...');
  const mysqlPaths = getMySQLPaths();
  const apachePaths = getApachePaths();

  // 1. Force MySQL Config (Port 3165 + Remote Access)
  if (fs.existsSync(mysqlPaths.config)) {
    try {
      let content = await fsPromises.readFile(mysqlPaths.config, 'utf8');
      
      // Update key_buffer to key_buffer_size to avoid warning
      content = content.replace(/key_buffer\s*=/g, 'key_buffer_size =');
      
      if (!content.includes('port=3165')) {
        console.log('[AUTO] Ajustando porta do MySQL para 3165...');
        content = content.replace(/port\s*=\s*\d+/g, 'port=3165');
        if (!content.includes('bind-address')) {
            content = content.replace(/\[mysqld\]/g, '[mysqld]\nbind-address = 0.0.0.0');
        } else {
            content = content.replace(/^bind-address\s*=.+/gm, '#bind-address = 0.0.0.0');
        }
        await fsPromises.writeFile(mysqlPaths.config, content);
      }
    } catch (e) { console.error('[AUTO] Erro ao configurar MySQL:', e.message); }
  }

  // 2. Start MySQL if stopped (Force Kill existing first for Windows)
  try {
    if (process.platform === 'win32') {
       console.log('[AUTO] Limpando instâncias de MySQL para evitar conflitos...');
       require('child_process').execSync('taskkill /F /IM mysqld.exe /T /FI "STATUS eq RUNNING"');
    }
    
    setTimeout(() => {
        console.log('[AUTO] Iniciando MySQL na porta 3165...');
        if (process.platform === 'win32') {
          require('child_process').exec(`"${mysqlPaths.bin}" --defaults-file="${mysqlPaths.config}" --standalone`);
        } else {
          require('child_process').exec('sudo systemctl start mysql');
        }
    }, 1000);
  } catch (e) {}

  // 3. Start Apache (for phpMyAdmin) - Kill existing first for Windows
  try {
    const apachePaths = getApachePaths();
    if (process.platform === 'win32' && fs.existsSync(apachePaths.config)) {
       let content = await fsPromises.readFile(apachePaths.config, 'utf8');
       if (!content.includes('Listen 3136')) {
           console.log('[AUTO] Ajustando porta do Apache para 3136...');
           content = content.replace(/^Listen\s+\d+/gm, 'Listen 3136');
           content = content.replace(/^ServerName\s+localhost:\d+/gm, 'ServerName localhost:3136');
           await fsPromises.writeFile(apachePaths.config, content);
       }
    }

    if (process.platform === 'win32') {
       console.log('[AUTO] Iniciando Apache (Porta 3136)...');
       require('child_process').execSync('taskkill /F /IM httpd.exe /T /FI "STATUS eq RUNNING"');
       setTimeout(() => {
         require('child_process').exec(`"${apachePaths.bin}"`);
       }, 500);
    }
  } catch (e) {}

  // 4. Force phpMyAdmin Config (Port 3165)
  try {
    const pmaConfig = 'C:\\xampp\\phpMyAdmin\\config.inc.php';
    if (process.platform === 'win32' && fs.existsSync(pmaConfig)) {
       let content = await fsPromises.readFile(pmaConfig, 'utf8');
       if (!content.includes("'port'] = '3165'")) {
         console.log('[AUTO] Ajustando porta no phpMyAdmin para 3165...');
         content = content.replace("['host'] = '127.0.0.1';", "['host'] = '127.0.0.1';\n$cfg['Servers'][$i]['port'] = '3165';");
         await fsPromises.writeFile(pmaConfig, content);
       }
    }
  } catch (e) {}
}

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await autoStartServices();
});
