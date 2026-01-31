import pkg from 'whatsapp-web.js';
import express from 'express';
import QRCode from 'qrcode';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import { Server } from "socket.io";
import winston from 'winston';
import rateLimit from 'express-rate-limit';
import { getProductDetailsTemplate } from './templates.js';

const { Client, LocalAuth, MessageMedia } = pkg;

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8000',
  'http://localhost:4321',
  'https://apitami.tamimaquinarias.com',
  'https://tamimaquinarias.com',
];

// Se crea carpeta de logs si no existe
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs', { recursive: true });
}

// Configuracion de logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS }
});

let activeSocketConnections = 0;
const MAX_SOCKET_CONNECTIONS = 10; // conexiones maximas

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 peticiones por minuto
  message: { success: false, message: 'Demasiadas peticiones, intenta más tarde' },
  standardHeaders: true,
  legacyHeaders: false
});

const sendMessageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 20, // 20 mensajes por minuto
  message: { success: false, message: 'Límite de mensajes alcanzado, espera un momento' },
  standardHeaders: true,
  legacyHeaders: false
});

const sendImageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 imágenes por minuto
  message: { success: false, message: 'Límite de imágenes alcanzado, espera un momento' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));
app.use(generalLimiter);

// Variables globales
let whatsappClient = null;
let currentQR = null;
let isReady = false;
let isInitializing = false;

// Inicializacion del cliente de WhatsApp
function initWhatsApp() {
  if (whatsappClient) {
    logger.warn('Cliente de WhatsApp ya existe, cancelando inicialización');
    return;
  }

  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './auth_info' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        /* '--single-process', */
        '--disable-gpu'
      ]
    },
  });

  whatsappClient.on('qr', async (qr) => {
    logger.info('Codigo QR generado');
    try {
      currentQR = await QRCode.toDataURL(qr);

      // Se emite a todos los clientes conectados
      io.emit('qr-update', {
        qrData: {
          image: currentQR,
          expiresAt: Date.now() + 60000,
          createdAt: new Date().toISOString()
        },
        connectionStatus: 'qr-ready'
      });
    } catch (error) {
      logger.error('Error al generar código QR', { error: error.message });
    }
  });

  // WhatsApp conectado
  whatsappClient.on('ready', () => {
    logger.info('Cliente de WhatsApp listo');
    isReady = true;
    currentQR = null;

    io.emit('qr-update', {
      connectionStatus: 'connected',
      qrData: null
    });
  });

  // Desconectado
  whatsappClient.on('disconnected', (reason) => {
    logger.warn('Cliente de WhatsApp desconectado', { reason });
    isReady = false;

    io.emit('qr-update', {
      connectionStatus: 'disconnected'
    });

    // Se intenta reconectar automaticamente
    setTimeout(() => {
      logger.info('Intentando reconectar el cliente de WhatsApp');
      if (whatsappClient) {
        whatsappClient.initialize();
      }
    }, 3000);
  });

  whatsappClient.on('auth_failure', (msg) => {
    logger.error('Fallo de autenticación', { message: msg });
    isReady = false;
  });

  whatsappClient.initialize();
}

// funcion para validar numero
async function validateWhatsAppNumber(numberId, skipValidation = false, chatId = null) {
  if (skipValidation && chatId) {
    return { _serialized: chatId };
  }

  try {
    const registeredNumber = await whatsappClient.getNumberId(numberId);

    return registeredNumber;
  } catch (error) {
    logger.error('Error al validar número', { error: error.message, numberId });
    return null;
  }
}

/********************* ENDPOINTS *********************/

// para ver el estado de la conexion y el QR
app.get('/api/whatsapp/status', (req, res) => {
  try {
    res.json({
      isConnected: isReady,
      hasActiveQR: !!currentQR,
      qrData: currentQR ? {
        image: currentQR,
        expiresAt: Date.now() + 60000
      } : null,
      connectionStatus: isReady ? 'connected' : (currentQR ? 'qr-ready' : 'disconnected')
    });
  } catch (error) {
    logger.error('Error al obtener estado de WhatsApp', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error al obtener el estado'
    });
  }
});

// se solicita un nuevo QR
app.post('/api/whatsapp/request-qr', async (req, res) => {
  try {
    if (isReady) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp ya está conectado'
      });
    }

    if (isInitializing) {
      return res.status(409).json({
        success: false,
        message: 'Ya hay una operación en progreso'
      });
    }
    isInitializing = true;

    if (!whatsappClient) {
      initWhatsApp();
    } else {
      await whatsappClient.destroy();
      whatsappClient = null;
      initWhatsApp();
    }

    isInitializing = false;

    res.json({
      success: true,
      message: 'Generando nuevo QR...'
    });
  } catch (error) {
    isInitializing = false;
    logger.error('Error al solicitar nuevo QR', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error al generar QR'
    });
  }
});

// se envia un mensaje con imagen
app.post('/api/send-product-info', sendImageLimiter, async (req, res) => {
  try {
    if (!isReady) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp no está conectado'
      });
    }

    const { productName, description, phone, email, imageData } = req.body;
    let newPhone = phone.replace('+', '').replace(' ', '');

    // se valida el numero
    if (!newPhone || newPhone.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'El número de teléfono es obligatorio'
      });
    }

    const numberId = newPhone.replace(/\D/g, '');

    // se valida el formato del numero
    if (numberId.length < 10 || numberId.length > 15) {
      return res.status(400).json({
        success: false,
        message: 'El formato del número de teléfono no es válido'
      });
    }

    const registeredNumber = await validateWhatsAppNumber(numberId);
    if (!registeredNumber) {
      return res.status(404).json({
        success: false,
        message: 'El número no está registrado en WhatsApp'
      });
    }
    const finalChatId = registeredNumber._serialized;

    if (!imageData) {
      return res.status(400).json({
        success: false,
        message: 'No se proporcionó la imagen'
      });
    }

    // la imagen debe ser una cadena
    if (typeof imageData !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'El formato de la imagen no es válido'
      });
    }

    let media;
    let mimeType = 'image/jpeg';

    if (imageData.startsWith('http://') || imageData.startsWith('https://')) { // urls
      try {
        media = await MessageMedia.fromUrl(imageData);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: 'No se pudo descargar la imagen desde la URL proporcionada'
        });
      }
    } else if (imageData.startsWith('data:image/')) { // base64 con prefijo
      // se detecta el tipo de imagen
      if (imageData.startsWith('data:image/png')) {
        mimeType = 'image/png';
      } else if (imageData.startsWith('data:image/jpg') || imageData.startsWith('data:image/jpeg')) {
        mimeType = 'image/jpeg';
      } else if (imageData.startsWith('data:image/gif')) {
        mimeType = 'image/gif';
      } else if (imageData.startsWith('data:image/webp')) {
        mimeType = 'image/webp';
      } else {
        return res.status(400).json({
          success: false,
          message: 'El formato de imagen no es válido. Debe ser PNG, JPEG, GIF o WEBP'
        });
      }

      const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

      if (!base64Data || base64Data.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Los datos de la imagen están vacíos'
        });
      }

      // Validar tamaño
      const sizeInMB = (base64Data.length * 0.75) / (1024 * 1024);
      if (sizeInMB > 2) {
        return res.status(400).json({
          success: false,
          message: `La imagen es demasiado grande (${sizeInMB.toFixed(2)}MB). Máximo 2MB`
        });
      }

      media = new MessageMedia(mimeType, base64Data);

    } else { // base64 puro
      const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
      if (!base64Regex.test(imageData.replace(/\s/g, ''))) {
        return res.status(400).json({
          success: false,
          message: 'El formato de base64 no es válido'
        });
      }

      const sizeInMB = (imageData.length * 0.75) / (1024 * 1024);
      if (sizeInMB > 2) {
        return res.status(400).json({
          success: false,
          message: `La imagen es demasiado grande (${sizeInMB.toFixed(2)}MB). Máximo 2MB`
        });
      }

      media = new MessageMedia(mimeType, imageData);
    }

    const options = { // opciones de envio
      sendSeen: false
    };

    let caption = getProductDetailsTemplate({
      productName,
      description,
      phone,
      email
    });

    if (caption) { // solo si hay caption
      options.caption = caption;
    }

    const result = await whatsappClient.sendMessage(finalChatId, media, options);

    res.json({
      success: true,
      messageId: result.id.id,
      chatId: finalChatId,
      timestamp: result.timestamp
    });
  } catch (error) {
    logger.error('Error al enviar imagen por WhatsApp', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error desconocido al enviar la imagen'
    });
  }
});

// se reinicia la sesion de whatsapp
app.post('/api/whatsapp/reset', async (req, res) => {
  try {
    if (isInitializing) {
      return res.status(409).json({
        success: false,
        message: 'Ya hay una operación de reseteo en progreso'
      });
    }
    isInitializing = true;

    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (error) {
        logger.warn('Error al destruir cliente', { error: error.message });
      }
    }

    const path = './auth_info';
    if (fs.existsSync(path)) {
      try {
        fs.rmSync(path, { recursive: true, force: true });
      } catch (error) {
        logger.error('Error al eliminar carpeta de autenticación', { error: error.message });
      }
    }

    currentQR = null;
    isReady = false;
    whatsappClient = null;

    io.emit('qr-update', {
      connectionStatus: 'disconnected',
      qrData: null
    });

    isInitializing = false;

    res.json({
      success: true,
      message: 'Sesión reseteada'
    });
  } catch (error) {
    isInitializing = false;
    logger.error('Error al resetear la sesión de WhatsApp', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error al resetear la sesión'
    });
  }
});

/********************* SOCKET.IO *********************/

// Socket.io para actualizaciones en tiempo real
io.on('connection', (socket) => {
  if (activeSocketConnections >= MAX_SOCKET_CONNECTIONS) {
    socket.emit('error', { message: 'Servidor con demasiadas conexiones, intenta más tarde' });
    socket.disconnect(true);
    return;
  }

  activeSocketConnections++;

  try {
    // Enviar estado actual inmediatamente
    socket.emit('qr-update', {
      isConnected: isReady,
      hasActiveQR: !!currentQR,
      qrData: currentQR ? { image: currentQR } : null,
      connectionStatus: isReady ? 'connected' : (currentQR ? 'qr-ready' : 'disconnected')
    });
  } catch (error) {
    logger.error('Error al enviar estado inicial al socket', {
      error: error.message,
      socketId: socket.id
    });
  }

  socket.on('disconnect', () => {
    logger.info('Cliente de socket desconectado', { socketId: socket.id });
    activeSocketConnections--;
  });

  socket.on('error', (error) => {
    logger.error('Error en socket', {
      error: error.message,
      socketId: socket.id
    });
  });
});

// error global del servidor
server.on('error', (error) => {
  logger.error('Error en el servidor HTTP', { error: error.message });
});

// Iniciar servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Servicio de WhatsApp iniciado en el puerto: ${PORT}`);
  initWhatsApp();
});