require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const server = http.createServer(app);

// Configuration CORS pour Render + Netlify
const getCorsOrigins = () => {
  const origins = [
    "https://benelvisio.netlify.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://benelvisio.netlify.app"
  ];
  
  // Ajouter l'URL Render automatiquement
  if (process.env.RENDER_EXTERNAL_URL) {
    origins.push(process.env.RENDER_EXTERNAL_URL);
  }
  
  console.log('🌐 CORS Origins:', origins);
  return origins;
};

const io = socketIo(server, {
  cors: {
    origin: getCorsOrigins(),
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
app.use(cors({
  origin: getCorsOrigins(),
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Configuration base de données pour Render
const dbConfig = {
  host: process.env.DB_HOST || 'benelmoney-mysql.localto.net',
  port: process.env.DB_PORT || 3132,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Hedu2018@',
  database: process.env.DB_NAME || 'benelvisio',
  charset: 'utf8mb4',
  connectTimeout: 60000,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  connectionLimit: 10
};

let dbPool;

// Fonction pour initialiser la base de données
async function initializeDatabase() {
  try {
    console.log('🔗 Tentative de connexion MySQL...');
    console.log('📊 Host:', dbConfig.host);
    console.log('📊 Port:', dbConfig.port);
    console.log('📊 Database:', dbConfig.database);
    
    dbPool = mysql.createPool(dbConfig);
    
    // Test de connexion
    const connection = await dbPool.getConnection();
    console.log('✅ Connecté à MySQL avec succès!');
    
    // Créer les tables
    await createTables();
    
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Erreur connexion MySQL:', error.message);
    console.log('🔄 Nouvelle tentative dans 10 secondes...');
    return false;
  }
}

async function createTables() {
  try {
    console.log('🗃️ Création des tables...');
    
    // Table users
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        plan_type ENUM('basic', 'premium', 'enterprise') DEFAULT 'basic',
        subscription_status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP NULL,
        INDEX idx_email (email),
        INDEX idx_plan (plan_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Table meetings
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS meetings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(20) UNIQUE NOT NULL,
        host_id INT NOT NULL,
        title VARCHAR(255) DEFAULT 'Réunion Benelvisio',
        max_participants INT DEFAULT 4,
        duration_minutes INT DEFAULT 40,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL,
        status ENUM('active', 'ended', 'cancelled') DEFAULT 'active',
        FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_code (code),
        INDEX idx_host (host_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Table user_sessions
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        socket_id VARCHAR(255) NOT NULL,
        room_id VARCHAR(50) NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        left_at TIMESTAMP NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_socket (socket_id),
        INDEX idx_room (room_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ Tables créées avec succès!');
    
    // Vérifier si des utilisateurs existent
    const [users] = await dbPool.execute('SELECT COUNT(*) as count FROM users');
    if (users[0].count === 0) {
      console.log('👤 Aucun utilisateur trouvé - base prête');
    } else {
      console.log(`👤 ${users[0].count} utilisateur(s) existant(s)`);
    }
    
  } catch (error) {
    console.error('❌ Erreur création tables:', error.message);
    throw error;
  }
}

// Stockage en mémoire pour les rooms et timers
const rooms = new Map();
const roomTimers = new Map();
const userRooms = new Map();

// Fonction pour démarrer le timer d'une room
function startRoomTimer(roomId, planType, hostSocketId, meetingId) {
  if (planType === 'basic') {
    const timeout = 40 * 60 * 1000; // 40 minutes
    
    console.log(`⏰ Timer démarré pour ${roomId} (40 minutes - Basic)`);

    const timer = setTimeout(async () => {
      console.log(`⏰ Timeout atteint pour ${roomId}`);
      
      // Marquer la réunion comme terminée
      try {
        await dbPool.execute(
          'UPDATE meetings SET ended_at = NOW(), status = "ended" WHERE id = ?',
          [meetingId]
        );
      } catch (error) {
        console.error('Erreur mise à jour meeting:', error);
      }
      
      // Envoyer notification
      io.to(roomId).emit('meeting-ended', {
        reason: 'time_limit',
        message: 'La réunion a atteint la limite de 40 minutes (formule Basique).',
        roomId: roomId
      });

      // Nettoyer la room
      const room = rooms.get(roomId);
      if (room) {
        room.forEach((userData, socketId) => {
          io.to(socketId).emit('force-disconnect', {
            reason: 'time_limit',
            message: 'Temps écoulé - Formule Basique limitée à 40 minutes'
          });
        });
        room.clear();
        rooms.delete(roomId);
      }
      
      roomTimers.delete(roomId);
      console.log(`🔴 Réunion ${roomId} arrêtée`);
      
    }, timeout);
    
    roomTimers.set(roomId, { 
      timer, 
      hostSocketId, 
      startTime: Date.now(),
      meetingId: meetingId
    });
  }
}

function stopRoomTimer(roomId) {
  if (roomTimers.has(roomId)) {
    const { timer, meetingId } = roomTimers.get(roomId);
    clearTimeout(timer);
    
    if (meetingId) {
      dbPool.execute(
        'UPDATE meetings SET ended_at = NOW(), status = "ended" WHERE id = ?',
        [meetingId]
      ).catch(console.error);
    }
    
    roomTimers.delete(roomId);
    console.log(`⏹️ Timer arrêté pour ${roomId}`);
  }
}

function getRemainingTime(roomId) {
  if (roomTimers.has(roomId)) {
    const { startTime } = roomTimers.get(roomId);
    const elapsed = Date.now() - startTime;
    const remaining = (40 * 60 * 1000) - elapsed;
    return Math.max(0, Math.floor(remaining / 1000));
  }
  return null;
}

// Routes API
app.post('/api/register', async (req, res) => {
  const { fullName, email, password, planType } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Tous les champs sont obligatoires' 
    });
  }

  try {
    // Vérifier si l'email existe
    const [existing] = await dbPool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ 
        success: false, 
        error: 'Email déjà utilisé' 
      });
    }

    // Créer l'utilisateur
    const [result] = await dbPool.execute(
      'INSERT INTO users (email, password, full_name, plan_type) VALUES (?, ?, ?, ?)',
      [email, password, fullName, planType || 'basic']
    );

    const userId = result.insertId;
    
    // Générer token
    const token = Buffer.from(JSON.stringify({
      id: userId,
      email: email,
      plan: planType || 'basic'
    })).toString('base64');

    console.log(`👤 Nouvel utilisateur: ${email} (${planType || 'basic'})`);

    res.json({
      success: true,
      token: token,
      user: {
        id: userId,
        email: email,
        full_name: fullName,
        plan_type: planType || 'basic',
        is_premium: planType !== 'basic'
      },
      requiresPayment: planType !== 'basic'
    });

  } catch (error) {
    console.error('Erreur inscription:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur création compte' 
    });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ 
      success: false, 
      error: 'Email et mot de passe requis' 
    });
  }

  try {
    const [users] = await dbPool.execute(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: 'Email ou mot de passe incorrect' 
      });
    }

    const user = users[0];

    // Vérification mot de passe
    if (user.password !== password) {
      return res.status(401).json({ 
        success: false, 
        error: 'Email ou mot de passe incorrect' 
      });
    }

    // Mettre à jour dernière connexion
    await dbPool.execute(
      'UPDATE users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Générer token
    const token = Buffer.from(JSON.stringify({
      id: user.id,
      email: user.email,
      plan: user.plan_type
    })).toString('base64');

    console.log(`🔐 Connexion: ${email} (${user.plan_type})`);

    res.json({
      success: true,
      token: token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        plan_type: user.plan_type,
        is_premium: user.plan_type !== 'basic'
      }
    });

  } catch (error) {
    console.error('Erreur login:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur de connexion' 
    });
  }
});

app.post('/api/create-meeting', async (req, res) => {
  const { userId, meetingTitle, maxParticipants } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Utilisateur non identifié' 
    });
  }

  const generateCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  };

  try {
    const meetingCode = generateCode();
    
    const [result] = await dbPool.execute(
      'INSERT INTO meetings (code, host_id, title, max_participants) VALUES (?, ?, ?, ?)',
      [meetingCode, userId, meetingTitle || 'Réunion Benelvisio', maxParticipants || 4]
    );

    const meetingId = result.insertId;
    console.log(`🎬 Nouvelle réunion: ${meetingCode} par user ${userId}`);

    res.json({
      success: true,
      meeting: {
        id: meetingId,
        code: meetingCode,
        title: meetingTitle || 'Réunion Benelvisio',
        max_participants: maxParticipants || 4
      }
    });

  } catch (error) {
    console.error('Erreur création meeting:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur création réunion' 
    });
  }
});

// Route pour le temps restant
app.get('/api/room-time-remaining/:roomId', (req, res) => {
  const { roomId } = req.params;
  const remaining = getRemainingTime(roomId);
  
  res.json({
    success: true,
    remainingTime: remaining,
    hasTimer: roomTimers.has(roomId)
  });
});

// Route pour les stats utilisateur
app.get('/api/user-stats/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const [result] = await dbPool.execute(
      'SELECT COUNT(*) as total_meetings FROM meetings WHERE host_id = ?',
      [userId]
    );
    
    res.json({
      success: true,
      stats: {
        total_meetings: result[0].total_meetings
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Erreur base de données' });
  }
});

// Health check (important pour Render)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Benelvisio API',
    environment: process.env.NODE_ENV || 'development',
    render_url: process.env.RENDER_EXTERNAL_URL || 'non défini'
  });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🔌 Nouvelle connexion:', socket.id);

  socket.on('join-room', async (data) => {
    const { roomId, userData } = data;
    
    socket.join(roomId);
    userData.socketId = socket.id;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
      
      if (userData.isHost && userData.planType === 'basic') {
        try {
          const [meetings] = await dbPool.execute(
            'SELECT id FROM meetings WHERE code = ?',
            [roomId]
          );
          
          if (meetings.length > 0) {
            startRoomTimer(roomId, 'basic', socket.id, meetings[0].id);
          }
        } catch (error) {
          console.error('Erreur récupération meeting:', error);
        }
        
        const remaining = getRemainingTime(roomId);
        socket.emit('time-limit-info', {
          limit: 40,
          remaining: remaining,
          message: 'Réunion limitée à 40 minutes (Formule Basique)'
        });
      }
    }

    const room = rooms.get(roomId);
    room.set(socket.id, userData);
    userRooms.set(socket.id, roomId);

    // Enregistrer session
    try {
      await dbPool.execute(
        'INSERT INTO user_sessions (user_id, socket_id, room_id) VALUES (?, ?, ?)',
        [userData.userId, socket.id, roomId]
      );
    } catch (error) {
      console.error('Erreur enregistrement session:', error);
    }

    if (roomTimers.has(roomId)) {
      const remaining = getRemainingTime(roomId);
      socket.emit('time-limit-info', {
        limit: 40,
        remaining: remaining,
        message: 'Réunion limitée à 40 minutes (Formule Basique)'
      });
    }

    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      userData: userData
    });

    const existingUsers = Array.from(room.entries())
      .filter(([id, _]) => id !== socket.id)
      .map(([id, user]) => ({ userId: id, userData: user }));

    socket.emit('existing-users', existingUsers);
    io.to(roomId).emit('users-updated', Array.from(room.values()));

    console.log(`👤 ${userData.name} a rejoint ${roomId} (${room.size} participants)`);
  });

  // WebRTC Signaling
  socket.on('webrtc-offer', (data) => {
    socket.to(data.to).emit('webrtc-offer', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.to).emit('webrtc-answer', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.to).emit('webrtc-ice-candidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  // Chat
  socket.on('chat-message', (data) => {
    io.to(data.roomId).emit('chat-message', {
      userName: data.userName,
      message: data.message,
      userId: socket.id,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('get-remaining-time', (data) => {
    const { roomId } = data;
    const remaining = getRemainingTime(roomId);
    
    socket.emit('remaining-time-update', {
      remaining: remaining,
      hasLimit: roomTimers.has(roomId)
    });
  });

  socket.on('leave-room', async (data) => {
    const { roomId, userData } = data;
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(socket.id);

      // Marquer session terminée
      try {
        await dbPool.execute(
          'UPDATE user_sessions SET left_at = NOW() WHERE socket_id = ?',
          [socket.id]
        );
      } catch (error) {
        console.error('Erreur mise à jour session:', error);
      }

      if (userData.isHost && roomTimers.has(roomId)) {
        stopRoomTimer(roomId);
      }

      socket.to(roomId).emit('user-left', {
        userId: socket.id,
        userData: userData
      });

      io.to(roomId).emit('users-updated', Array.from(room.values()));

      if (room.size === 0) {
        rooms.delete(roomId);
        if (roomTimers.has(roomId)) {
          stopRoomTimer(roomId);
        }
      }

      userRooms.delete(socket.id);
      console.log(`👋 ${userData.name} a quitté ${roomId}`);
    }
  });

  socket.on('disconnect', async () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    const roomId = userRooms.get(socket.id);
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const userData = room.get(socket.id);
      
      if (userData) {
        room.delete(socket.id);

        // Marquer session terminée
        try {
          await dbPool.execute(
            'UPDATE user_sessions SET left_at = NOW() WHERE socket_id = ?',
            [socket.id]
          );
        } catch (error) {
          console.error('Erreur mise à jour session:', error);
        }

        if (userData.isHost && roomTimers.has(roomId)) {
          stopRoomTimer(roomId);
        }

        socket.to(roomId).emit('user-left', {
          userId: socket.id,
          userData: userData
        });

        io.to(roomId).emit('users-updated', Array.from(room.values()));

        if (room.size === 0) {
          rooms.delete(roomId);
          if (roomTimers.has(roomId)) {
            stopRoomTimer(roomId);
          }
        }

        console.log(`👋 ${userData.name} déconnecté de ${roomId}`);
      }
    }

    userRooms.delete(socket.id);
  });
});

// Route principale
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Benelvisio Backend API',
    version: '1.0.0',
    status: 'active',
    frontend: 'https://benelvisio.netlify.app',
    endpoints: {
      health: '/health',
      register: '/api/register',
      login: '/api/login',
      create_meeting: '/api/create-meeting',
      admin_stats: '/admin/stats'
    }
  });
});

// Stats admin
app.get('/admin/stats', async (req, res) => {
  try {
    const [planStats] = await dbPool.execute(
      'SELECT plan_type, COUNT(*) as count FROM users GROUP BY plan_type'
    );
    
    const [meetingStats] = await dbPool.execute(
      'SELECT COUNT(*) as total_meetings FROM meetings'
    );
    
    const [activeUsers] = await dbPool.execute(
      'SELECT COUNT(DISTINCT user_id) as active FROM user_sessions WHERE left_at IS NULL'
    );
    
    res.json({
      users_by_plan: planStats,
      total_meetings: meetingStats[0].total_meetings,
      active_users: activeUsers[0].active,
      active_rooms: rooms.size,
      environment: process.env.NODE_ENV || 'development',
      render_url: process.env.RENDER_EXTERNAL_URL || 'local'
    });
  } catch (error) {
    console.error('Erreur stats admin:', error);
    res.status(500).json({ error: 'Erreur base de données' });
  }
});

// Route 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route non trouvée',
    available_routes: [
      'GET /',
      'GET /health',
      'POST /api/register',
      'POST /api/login',
      'POST /api/create-meeting',
      'GET /admin/stats'
    ]
  });
});

// Initialisation du serveur
async function startServer() {
  console.log('🚀 Démarrage Benelvisio sur Render...');
  console.log('📊 NODE_ENV:', process.env.NODE_ENV);
  console.log('🔧 PORT:', process.env.PORT);
  console.log('🌐 RENDER_EXTERNAL_URL:', process.env.RENDER_EXTERNAL_URL);
  
  let retries = 5;
  while (retries > 0) {
    const dbInitialized = await initializeDatabase();
    
    if (dbInitialized) {
      break;
    }
    
    retries--;
    if (retries > 0) {
      console.log(`🔄 Nouvelle tentative dans 10 secondes... (${retries} restantes)`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    } else {
      console.error('❌ Échec connexion base de données après plusieurs tentatives');
      process.exit(1);
    }
  }

  const PORT = process.env.PORT || 10000;

  server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('🚀 BENELVISIO ULTIMATE - SERVEUR PRÊT');
    console.log('='.repeat(50));
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV}`);
    console.log(`🌐 Frontend URL: https://benelvisio.netlify.app`);
    console.log(`🌐 Render URL: ${process.env.RENDER_EXTERNAL_URL || 'Non défini'}`);
    console.log(`🗃️ Database: ${dbConfig.host}:${dbConfig.port}`);
    console.log(`⏰ Limite 40min activée pour Basic`);
    console.log(`🔧 WebSockets: Activés`);
    console.log(`📊 Health: /health`);
    console.log(`📈 Stats: /admin/stats`);
    console.log('='.repeat(50));
  });
}

// Gestion des erreurs non catchées
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// Démarrer le serveur
startServer();
