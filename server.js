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
const os = require('os');

const APPS_FILE = path.join(__dirname, 'apps.json');
let installingApps = {};
let appProcesses = {}; // Store running child processes

// Root Directories for modern apps (outside XAMPP)
const OPTINODE_ROOT = 'C:\\OptiNode';
const APPS_DIR = path.join(OPTINODE_ROOT, 'apps');
const DATA_DIR = path.join(OPTINODE_ROOT, 'data');

// Ensure root structure exists
if (!fs.existsSync(OPTINODE_ROOT)) fs.mkdirSync(OPTINODE_ROOT, { recursive: true });
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Helper: Get local IP
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// Helper: Read/Write Apps
async function getApps() {
  try {
    if (!fs.existsSync(APPS_FILE)) await fsPromises.writeFile(APPS_FILE, JSON.stringify([]));
    return JSON.parse(await fsPromises.readFile(APPS_FILE, 'utf8'));
  } catch (e) { return []; }
}
async function saveApp(app) {
  const apps = await getApps();
  apps.push(app);
  await fsPromises.writeFile(APPS_FILE, JSON.stringify(apps, null, 2));
}

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

app.post('/api/files/share', checkAuth, async (req, res) => {
  const { targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'Caminho inválido' });

  const absolutePath = path.resolve(targetPath);
  if (!fs.existsSync(absolutePath) || !fs.lstatSync(absolutePath).isDirectory()) {
    return res.status(400).json({ error: 'Apenas pastas podem ser compartilhadas.' });
  }

  const shareName = path.basename(absolutePath).replace(/[^a-zA-Z0-9]/g, '_');
  const localIP = getLocalIP();
  const { exec } = require('child_process');

  // Command to share folder on Windows: net share <name>="<path>" /grant:everyone,full
  // We use CMD/C because net share is a shell command
  const cmd = `net share "${shareName}"="${absolutePath}" /grant:everyone,full`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error && !stdout.includes('already shared')) {
      console.error('Erro ao compartilhar:', stderr);
      return res.status(500).json({ error: 'Falha ao compartilhar pasta. Verifique permissões de administrador.' });
    }
    
    res.json({ 
      success: true, 
      shareName, 
      networkPath: `\\\\${localIP}\\${shareName}` 
    });
  });
});

app.post('/api/files/unshare', checkAuth, async (req, res) => {
  const { targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'Caminho inválido' });

  const absolutePath = path.resolve(targetPath);
  const shareName = path.basename(absolutePath).replace(/[^a-zA-Z0-9]/g, '_');
  const { exec } = require('child_process');

  const cmd = `net share "${shareName}" /delete`;
  
  exec(cmd, (error, stdout, stderr) => {
    // If it's already not shared, we count as success
    if (error && !stderr.includes('cannot be found')) {
      console.error('Erro ao remover compartilhamento:', stderr);
      return res.status(500).json({ error: 'Falha ao remover compartilhamento.' });
    }
    res.json({ success: true });
  });
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
    
    // 1. Remove anonymous users to avoid connection hijacking on localhost
    try {
        await connection.query(`DELETE FROM mysql.user WHERE User = ''`);
        await connection.query(`FLUSH PRIVILEGES`);
    } catch (e) { console.log("Note: Anonymous users cleanup skipped or failed."); }

    // 2. Create/Update database
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    
    // 3. Handle User Access for all hosts
    const hosts = ['%', 'localhost', '127.0.0.1'];
    for (const h of hosts) {
        // Use a more robust way to create or update password
        await connection.query(`CREATE USER IF NOT EXISTS '${username}'@'${h}' IDENTIFIED BY '${password || ''}'`);
        await connection.query(`ALTER USER '${username}'@'${h}' IDENTIFIED BY '${password || ''}'`);
        await connection.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'${h}'`);
    }
    
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

// --- App Store Endpoints ---
app.get('/api/apps/list', checkAuth, async (req, res) => {
  const apps = await getApps();
  res.json({ apps, installing: installingApps });
});

app.post('/api/apps/uninstall', checkAuth, async (req, res) => {
  const { appName, dbName } = req.body;
  if (!appName) return res.status(400).json({ error: 'Nome do app não informado' });

  try {
    // 1. Remove files
    const appPath = path.join('C:\\xampp\\htdocs', appName);
    if (fs.existsSync(appPath)) {
        require('child_process').execSync(`rmdir /S /Q "${appPath}"`);
    }

    // 2. Remove Database
    if (dbName) {
        await fetch(`http://localhost:3000/api/mysql/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: req.headers.cookie },
            body: JSON.stringify({ dbName })
        });
    }

    // 3. Remove from apps.json
    let apps = await getApps();
    apps = apps.filter(a => a.name !== appName);
    await fsPromises.writeFile(APPS_FILE, JSON.stringify(apps, null, 2));

    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/apps/install/wordpress', checkAuth, async (req, res) => {
  const { appName, dbName: customDbName, dbUser, dbPass } = req.body;
  if (!appName) return res.status(400).json({ error: 'Dados incompletos' });
  
  const dbName = customDbName || appName.replace(/[^a-zA-Z0-9]/g, '_');

  // Prevent duplicate installation ID
  if (installingApps[appName]) return res.status(400).json({ error: 'Já existe uma instalação em andamento' });

  const appPath = path.join('C:\\xampp\\htdocs', appName);
  if (fs.existsSync(appPath)) return res.status(400).json({ error: 'Pasta já existe' });

  installingApps[appName] = { percent: 0, status: 'Iniciando...' };
  io.emit('install_status', installingApps);

  // Background process
  (async () => {
    try {
      const dbName = appName.replace(/[^a-zA-Z0-9]/g, '_');
      
      // 1. Create Database
      updateStatus(appName, 10, 'Criando banco de dados...');
      const dbRes = await fetch(`http://localhost:3000/api/mysql/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: req.headers.cookie },
        body: JSON.stringify({ dbName, username: dbUser || 'root', password: dbPass || '' })
      });

      if (!dbRes.ok) {
          const errData = await dbRes.json();
          throw new Error('Falha ao criar banco: ' + (errData.error || 'Erro desconhecido'));
      }

      // 2. Download WordPress
      updateStatus(appName, 20, 'Fazendo download de WordPress...');
      const zipPath = path.join(__dirname, 'wp_temp.zip');
      const file = fs.createWriteStream(zipPath);
      
      const https = require('https');
      https.get('https://wordpress.org/latest.zip', (response) => {
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          const p = 20 + Math.floor((downloaded / totalSize) * 40);
          updateStatus(appName, p, `Baixando... ${Math.floor((downloaded / totalSize) * 100)}%`);
        });

        response.pipe(file);

        file.on('finish', async () => {
          file.close();
          
          // 3. Extract
          updateStatus(appName, 70, 'Extraindo arquivos...');
          const stream = fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: 'C:\\xampp\\htdocs' }));
          
          stream.on('close', async () => {
            // Rename 'wordpress' to appName
            const wpPath = path.join('C:\\xampp\\htdocs', 'wordpress');
            fs.renameSync(wpPath, appPath);
            fs.unlinkSync(zipPath);

            // 4. Configure wp-config.php
            updateStatus(appName, 90, 'Configurando wp-config.php...');
            const configSamplePath = path.join(appPath, 'wp-config-sample.php');
            const configPath = path.join(appPath, 'wp-config.php');
            let config = await fsPromises.readFile(configSamplePath, 'utf8');
            
            const serverIP = getLocalIP();
            const siteUrl = `http://${serverIP}:3136/${appName}`;

            // Robust replacement handling various quote/space styles in define()
            config = config.replace(/DB_NAME',\s*['"].*?['"]/g, `DB_NAME', '${dbName}'`);
            config = config.replace(/DB_USER',\s*['"].*?['"]/g, `DB_USER', '${dbUser || 'root'}'`);
            config = config.replace(/DB_PASSWORD',\s*['"].*?['"]/g, `DB_PASSWORD', '${dbPass || ''}'`);
            config = config.replace(/DB_HOST',\s*['"].*?['"]/g, `DB_HOST', '127.0.0.1:3165'`);
            
            // Handle cases where 'localhost' is used without define (unlikely but safe)
            config = config.replace(/['"]localhost['"]/g, `'127.0.0.1:3165'`);
            
            // Add Home and SiteURL for IP access
            config += `\ndefine('WP_HOME', '${siteUrl}');\ndefine('WP_SITEURL', '${siteUrl}');\n`;

            await fsPromises.writeFile(configPath, config);

            // 5. Save and Finish
            await saveApp({ 
                name: appName, 
                type: 'WordPress', 
                url: siteUrl, 
                dbName, 
                date: new Date().toISOString() 
            });

            delete installingApps[appName];
            io.emit('install_status', installingApps);
            console.log(`[APP] WordPress '${appName}' instalado com sucesso.`);
          });
        });
      }).on('error', (err) => { throw err; });

    } catch (e) {
      console.error('Erro na instalação:', e);
      installingApps[appName].status = 'Erro: ' + e.message;
      io.emit('install_status', installingApps);
      setTimeout(() => { delete installingApps[appName]; io.emit('install_status', installingApps); }, 5000);
    }
  })();

  res.json({ success: true, message: 'Instalação iniciada em segundo plano' });
});

app.post('/api/apps/install/n8n', checkAuth, async (req, res) => {
  const appName = 'n8n';
  const appPath = path.join(APPS_DIR, appName);
  const n8nDataPath = path.join(DATA_DIR, appName);

  if (fs.existsSync(appPath)) return res.status(400).json({ error: 'A pasta n8n já existe em C:\\OptiNode\\apps.' });

  installingApps[appName] = { percent: 0, status: 'Iniciando instalação em C:\\OptiNode...' };
  io.emit('install_status', installingApps);

  (async () => {
    try {
      if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
      if (!fs.existsSync(n8nDataPath)) fs.mkdirSync(n8nDataPath, { recursive: true });

      updateStatus(appName, 20, 'Configurando ambiente Node.js...');
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);

      await execPromise('npm init -y', { cwd: appPath });

      updateStatus(appName, 40, 'Baixando n8n (pode demorar alguns minutos)...');
      
      // Use environment variable N8N_USER_FOLDER to store data in our data dir
      const n8nEnv = { ...process.env, N8N_USER_FOLDER: n8nDataPath };
      
      exec('npm install n8n', { cwd: appPath, env: n8nEnv }, async (error) => {
        if (error) {
          console.error('Erro ao instalar n8n:', error);
          if (installingApps[appName]) {
             installingApps[appName].status = 'Erro na instalação via NPM';
             io.emit('install_status', installingApps);
             setTimeout(() => { delete installingApps[appName]; io.emit('install_status', installingApps); }, 5000);
          }
          return;
        }

        updateStatus(appName, 90, 'Finalizando configuração...');
        const localIP = getLocalIP();
        const siteUrl = `http://${localIP}:5678`;

        await saveApp({
          name: 'n8n Automation',
          type: 'Workflow',
          url: siteUrl,
          dbName: 'SQLite (C:\\OptiNode\\data)',
          date: new Date().toISOString()
        });

        console.log('[APP] n8n instalado com sucesso em C:\\OptiNode.');
        delete installingApps[appName];
        io.emit('install_status', installingApps);
      });

    } catch (e) {
      console.error('Erro n8n:', e);
      if (installingApps[appName]) {
        installingApps[appName].status = 'Erro: ' + e.message;
        io.emit('install_status', installingApps);
        setTimeout(() => { delete installingApps[appName]; io.emit('install_status', installingApps); }, 5000);
      }
    }
  })();

  res.json({ success: true, message: 'Instalação iniciada em segundo plano' });
});

app.post('/api/apps/start', checkAuth, async (req, res) => {
  const { name } = req.body;
  const success = await startAppProcess(name);
  if (success === 'Running') return res.json({ success: true, message: 'Já está rodando' });
  if (success) return res.json({ success: true });
  res.status(400).json({ error: 'Falha ao iniciar ou app não compatível.' });
});

async function startAppProcess(name) {
  if (appProcesses[name]) return 'Running';

  const apps = await getApps();
  const app = apps.find(a => a.name === name);
  if (!app) return false;

  const { spawn } = require('child_process');
  
  if (name === 'n8n Automation') {
    const appPath = path.join(APPS_DIR, 'n8n');
    const n8nDataPath = path.join(DATA_DIR, 'n8n');
    const localIP = getLocalIP();
    const n8nEnv = { 
      ...process.env, 
      N8N_USER_FOLDER: n8nDataPath,
      N8N_SECURE_COOKIE: 'false',
      N8N_HOST: localIP,
      WEBHOOK_URL: `http://${localIP}:5678/`
    };
    
    console.log(`[AUTO] Dando partida em ${name}...`);
    const child = spawn('npx', ['n8n'], { 
      cwd: appPath, 
      env: n8nEnv,
      shell: true
    });

    appProcesses[name] = child;

    child.stdout.on('data', (data) => {
        // console.log(`[n8n] ${data}`); 
    });
    
    child.on('exit', () => {
      console.log(`[APP] ${name} encerrado.`);
      delete appProcesses[name];
    });

    return true;
  }
  return false;
}

app.post('/api/apps/stop', checkAuth, async (req, res) => {
  const { name } = req.body;
  if (!appProcesses[name]) return res.json({ success: true, message: 'Já está parado' });

  const child = appProcesses[name];
  child.kill(); 
  delete appProcesses[name];
  res.json({ success: true });
});

app.get('/api/apps/status', checkAuth, (req, res) => {
  const status = {};
  Object.keys(appProcesses).forEach(name => {
    status[name] = true;
  });
  res.json(status);
});

function updateStatus(id, percent, status) {
    if (installingApps[id]) {
        installingApps[id].percent = percent;
        installingApps[id].status = status;
        io.emit('install_status', installingApps);
    }
}

async function autoStartServices() {
  console.log('[AUTO] Verificando serviços no boot...');
  const { exec, execSync } = require('child_process');
  const mysqlPaths = getMySQLPaths();
  const apachePaths = getApachePaths();

  // 1. Force MySQL Config (Port 3165 + Remote Access)
  if (fs.existsSync(mysqlPaths.config)) {
    try {
      let content = await fsPromises.readFile(mysqlPaths.config, 'utf8');
      
      // Update key_buffer to key_buffer_size ONLY in [mysqld] section and stop before other sections
      if (content.includes('[mysqld]')) {
          const sections = content.split(/^\[/gm);
          for (let i = 0; i < sections.length; i++) {
              if (sections[i].startsWith('mysqld]')) {
                  sections[i] = sections[i].replace(/^key_buffer\s*=/gm, 'key_buffer_size =');
              }
          }
          content = sections.join('[');
      }
      
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
       console.log('[AUTO] Limpando instâncias e travas de MySQL/n8n...');
       try { execSync('taskkill /F /IM mysqld.exe /T /FI "STATUS eq RUNNING"'); } catch(e) {}
       try { execSync('taskkill /F /FI "localport eq 5678" /T'); } catch(e) {} // Clean n8n port
       
       // Remove lock files
       const dataDir = path.join(mysqlPaths.bin, '..', '..', 'data');
       ['mysql.pid', 'aria_log_control'].forEach(f => {
           const p = path.join(dataDir, f);
           if (fs.existsSync(p)) fs.unlinkSync(p);
       });
    }
    
    setTimeout(() => {
        console.log('[AUTO] Iniciando MySQL na porta 3165...');
        if (process.platform === 'win32') {
          require('child_process').exec(`"${mysqlPaths.bin}" --defaults-file="${mysqlPaths.config}" --standalone`, (err) => {
              if (err) console.error("[AUTO] Falha ao iniciar MySQL:", err.message);
          });
        } else {
          require('child_process').exec('sudo systemctl start mysql');
        }
    }, 1500); // Increased wait time
  } catch (e) { console.error('[AUTO] Erro no boot do MySQL:', e.message); }

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

  // 5. Auto-start installed apps (n8n, etc)
  try {
    const appsList = await getApps();
    for (const app of appsList) {
      if (app.type === 'Workflow') {
        await startAppProcess(app.name);
      }
    }
  } catch (e) {
    console.error('[AUTO] Erro ao auto-iniciar apps:', e.message);
  }
}

io.on('connection', async (socket) => {
  console.log('Client connected');
  
  // Send current installing apps state on connect
  socket.emit('install_status', installingApps);

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
server.listen(PORT, '0.0.0.0', async () => {
  const localIP = getLocalIP();
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Network Access: http://${localIP}:${PORT}`);
  await autoStartServices();
});
