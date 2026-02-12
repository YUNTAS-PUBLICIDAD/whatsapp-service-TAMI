import mysql from 'mysql2/promise';
import whatsappService from '../services/whatsapp.service.js';
import logger from '../services/logger.service.js';
import { getProductDetailsTemplate } from '../../templates.js';
import { WHATSAPP_CONFIG } from '../config/constants.js';

// Crear un pool de conexiones en lugar de una conexión directa
const pool = mysql.createPool({
    host: '82.197.82.125',
    user: 'u268804017_tamiusr',
    password: 'DatabaseTami4',
    database: 'u268804017_tamidb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

/**
 * Obtiene el estado de la conexión de WhatsApp y el QR
 */
export async function getStatus(req, res) {
    try {
        const status = whatsappService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('Error al obtener estado de WhatsApp', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al obtener el estado'
        });
    }
}

/**
 * Solicita un nuevo código QR
 */
export async function requestQR(req, res) {
    try {
        if (whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp ya está conectado'
            });
        }

        if (whatsappService.isInitializing) {
            return res.status(409).json({
                success: false,
                message: 'Ya hay una operación en progreso'
            });
        }

        // Si no existe el socket, se inicializa
        if (!whatsappService.sock) {
            await whatsappService.initialize();
        } else {
            // Si existe, se destruye y reinicia
            await whatsappService.destroy();
            await whatsappService.initialize();
        }

        res.json({
            success: true,
            message: 'Generando nuevo QR...'
        });
    } catch (error) {
        logger.error('Error al solicitar nuevo QR', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al generar QR'
        });
    }
}

/**
 * Envía información de producto con imagen
 */
export async function sendProductInfo(req, res) {
    try {
        if (!whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp no está conectado'
            });
        }

        const { productName, description, phone, email, imageData } = req.body;
        let newPhone = phone.replace('+', '').replace(' ', '');

        // Validar número
        if (!newPhone || newPhone.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'El número de teléfono es obligatorio'
            });
        }

        const numberId = newPhone.replace(/\D/g, '');

        // Validar formato del número
        if (numberId.length < 10 || numberId.length > 15) {
            return res.status(400).json({
                success: false,
                message: 'El formato del número de teléfono no es válido'
            });
        }

        // Validar número en WhatsApp
        const jid = await whatsappService.validateNumber(`${numberId}@s.whatsapp.net`);
        if (!jid) {
            return res.status(404).json({
                success: false,
                message: 'El número no está registrado en WhatsApp'
            });
        }

        // Validar imagen
        if (!imageData) {
            return res.status(400).json({
                success: false,
                message: 'No se proporcionó la imagen'
            });
        }

        if (typeof imageData !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'El formato de la imagen no es válido'
            });
        }

        // Procesar imagen
        let imageBuffer;

        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
            // Descargar desde URL
            try {
                const response = await fetch(imageData);
                if (!response.ok) {
                    throw new Error('No se pudo descargar la imagen');
                }
                imageBuffer = Buffer.from(await response.arrayBuffer());
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: 'No se pudo descargar la imagen desde la URL proporcionada'
                });
            }
        } else if (imageData.startsWith('data:image/')) {
            // Base64 con prefijo
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

            if (!base64Data || base64Data.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Los datos de la imagen están vacíos'
                });
            }

            // Validar tamaño
            const sizeInMB = (base64Data.length * 0.75) / (1024 * 1024);
            if (sizeInMB > WHATSAPP_CONFIG.maxImageSize) {
                return res.status(400).json({
                    success: false,
                    message: `La imagen es demasiado grande (${sizeInMB.toFixed(2)}MB). Máximo ${WHATSAPP_CONFIG.maxImageSize}MB`
                });
            }

            imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
            // Base64 puro
            const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
            if (!base64Regex.test(imageData.replace(/\s/g, ''))) {
                return res.status(400).json({
                    success: false,
                    message: 'El formato de base64 no es válido'
                });
            }

            const sizeInMB = (imageData.length * 0.75) / (1024 * 1024);
            if (sizeInMB > WHATSAPP_CONFIG.maxImageSize) {
                return res.status(400).json({
                    success: false,
                    message: `La imagen es demasiado grande (${sizeInMB.toFixed(2)}MB). Máximo ${WHATSAPP_CONFIG.maxImageSize}MB`
                });
            }

            imageBuffer = Buffer.from(imageData, 'base64');
        }

        // --- BLOQUE NUEVO: OBTENER Y PROCESAR TEXTO DINÁMICO ---
        let finalCaption = "";
        
        try {
            // 1. Buscamos el texto en la tabla usando el pool
            const [rows] = await pool.execute(
                'SELECT content FROM whatsapp_templates WHERE name = ?',
                ['product_details']
            );

            if (rows.length > 0) {
                const templateText = rows[0].content;
                const now = new Date();

                // 2. Definimos las variables que el usuario puede usar en el panel admin
                const variables = {
                    productName: productName,
                    description: description,
                    email: email,
                    phone: phone,
                    fecha: now.toLocaleDateString('es-PE', { timeZone: 'America/Lima' }),
                    hora: now.toLocaleTimeString('es-PE', { 
                        timeZone: 'America/Lima', 
                        hour: '2-digit', 
                        minute: '2-digit' 
                    })
                };

                // 3. Reemplazamos {{variable}} por el valor real
                finalCaption = templateText.replace(/{{(\w+)}}/g, (match, key) => {
                    return variables[key] || match;
                });
            } else {
                // Si por alguna razón no hay nada en la DB, usar template por defecto
                finalCaption = getProductDetailsTemplate({
                    productName,
                    description,
                    phone,
                    email
                });
            }
        } catch (dbError) {
            // Si hay error con la DB, usar template por defecto como fallback
            logger.error('Error al obtener template de DB', { error: dbError.message });
            finalCaption = getProductDetailsTemplate({
                productName,
                description,
                phone,
                email
            });
        }
        // --- FIN DEL BLOQUE NUEVO ---

        // Enviar imagen con el caption dinámico
        const result = await whatsappService.sendImage(jid, imageBuffer, finalCaption);

        res.json(result);
    } catch (error) {
        logger.error('Error al enviar imagen por WhatsApp', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error desconocido al enviar la imagen'
        });
    }
}

/**
 * Reinicia la sesión de WhatsApp
 */
export async function resetSession(req, res) {
    try {
        if (whatsappService.isInitializing) {
            return res.status(409).json({
                success: false,
                message: 'Ya hay una operación de reseteo en progreso'
            });
        }

        await whatsappService.resetSession();

        res.json({
            success: true,
            message: 'Sesión reseteada'
        });
    } catch (error) {
        logger.error('Error al resetear la sesión de WhatsApp', { error: error.message });
        if (whatsappService.sock) {
            res.json({
                success: true,
                message: 'Sesión reiniciada con advertencias. Generando QR...',
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Error al reiniciar sesión',
            });
        }
    }
}