import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import messageRoutes from './routes/message.routes.js';
import authRoutes from './routes/auth.routes.js';
import jwt from 'jsonwebtoken';
import whatsappService from './services/whatsapp.service.js';
import 'dotenv/config';

// ✅ ORÍGENES PERMITIDOS (incluye Vite)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000/', 'http://localhost:3001/', 'http://localhost:5173/'];

const app = express();
const server = createServer(app);
//as
// --------------------
// 🔐 SOCKET.IO (OK)
// --------------------
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
  }
});

app.use(helmet());

// --------------------
// ✅ CORS HTTP (FIX)
// --------------------
app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (Postman)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// ✅ PRE-FLIGHT (MUY IMPORTANTE)


// --------------------
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --------------------
// 🚦 RATE LIMIT
// --------------------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === '/api/qr-status' || req.path === '/api/qr-status/'
});

app.use(limiter);

// --------------------
// 🔑 AUTH
// --------------------
app.use('/api/auth', authRoutes);

// --------------------
// 💬 MENSAJES
// --------------------
app.use('/api', messageRoutes);

// --------------------
// 📡 SOCKET AUTH
// --------------------
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  const token = socket.handshake.auth.token;
  if (!token) {
    socket.disconnect();
    return;
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      socket.disconnect();
      return;
    }

    socket.userId = decoded.userId;
    socket.user = decoded;

    socket.emit('qr-status-update', whatsappService.getQRStatus());
  });

  socket.on('join-user', (userId) => {
    socket.join(`user-${userId}`);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.userId);
  });
});

// --------------------
// 📢 EMITS
// --------------------
export function emitQrStatusUpdate(status) {
  io.emit('qr-status-update', status);
}

export function emitQrStatusToUser(userId, status) {
  io.to(`user-${userId}`).emit('qr-status-update', status);
}

// --------------------
// ❌ ERRORES
// --------------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Error interno del servidor' });
});

export { server, io };
