import whatsappService from '../services/whatsapp.service.js';
import logger from '../services/logger.service.js';
import { getProductDetailsTemplate } from '../../templates.js';
import { WHATSAPP_CONFIG } from '../config/constants.js';

// NO importar mysql aquí arriba
let pool = null;

// Función para obtener la conexión solo cuando se necesite
async function getDbPool() {
    if (!pool) {
        const mysql = await import('mysql2/promise');
        pool = mysql.default.createPool({
            host: '82.197.82.125',
            user: 'u268804017_tamiusr',
            password: 'DatabaseTami4',
            database: 'u268804017_tamidb',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
    }
    return pool;
}

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

        // ✅ CAMBIO: Ahora recibimos productoId en lugar de solo productName
        const { productName, description, phone, email, imageData, productoId } = req.body;
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
                const contentType = response.headers.get('content-type') || null;
                imageBuffer = Buffer.from(await response.arrayBuffer());
                logger.info('Imagen descargada desde URL', { url: imageData, contentType, size: imageBuffer.length });
                // keep mimetype for sending
                detectedMimetype = contentType;
            } catch (error) {
                return res.status(400).json({
                    success: false,
                    message: 'No se pudo descargar la imagen desde la URL proporcionada'
                });
            }
        } else if (imageData.startsWith('data:image/')) {
            // Base64 con prefijo
            const mimeMatch = imageData.match(/^data:(image\/(\w+));base64,/);
            const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
            detectedMimetype = mimeMatch ? mimeMatch[1] : null;

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
            logger.info('Imagen proveniente de base64 (con prefijo)', { mimetype: detectedMimetype, size: imageBuffer.length });
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
            logger.info('Imagen proveniente de base64 (sin prefijo)', { size: imageBuffer.length });
        }

        // --- ✅ BLOQUE ACTUALIZADO: BUSCAR POR producto_id ---
        let finalCaption = "";
        
        try {
            // Obtener el pool de conexiones solo cuando se necesita
            const dbPool = await getDbPool();
            
            // ✅ CAMBIO: Buscar por producto_id en lugar de name
            let templateText = null;
            
            // Si tenemos productoId, buscar plantilla específica del producto
            if (productoId) {
                const [productRows] = await dbPool.execute(
                    'SELECT content FROM whatsapp_templates WHERE producto_id = ?',
                    [productoId]
                );
                
                if (productRows.length > 0) {
                    templateText = productRows[0].content;
                    logger.info(`Usando plantilla personalizada para producto ID: ${productoId}`);
                }
            }
            
            // Si no hay plantilla personalizada, usar template por defecto
            if (!templateText) {
                templateText = getProductDetailsTemplate({
                    productName,
                    description,
                    phone,
                    email
                });
                logger.info('Usando plantilla por defecto (no hay plantilla personalizada)');
            }

            // Definir variables disponibles para reemplazo
            const now = new Date();
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

            // Reemplazar variables {{variable}} por valores reales
            finalCaption = templateText.replace(/{{(\w+)}}/g, (match, key) => {
                return variables[key] || match;
            });

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
        // --- FIN DEL BLOQUE ACTUALIZADO ---

        // Enviar imagen con el caption dinámico
        const result = await whatsappService.sendImage(jid, imageBuffer, finalCaption, detectedMimetype || null);

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

/**
 * Procesa una imagen (URL o Base64) y devuelve un Buffer y el Mimetype detectado
 */
async function processImage(imageSource) {
    if (!imageSource) return { buffer: null, mimetype: null };

    let imageBuffer;
    let detectedMimetype = null;

    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
        try {
            const response = await fetch(imageSource);
            if (!response.ok) throw new Error('No se pudo descargar la imagen');
            detectedMimetype = response.headers.get('content-type') || null;
            imageBuffer = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            logger.error('Error al descargar imagen', { error: error.message, url: imageSource });
            return { buffer: null, mimetype: null };
        }
    } else if (imageSource.startsWith('data:')) {
        // Método robusto para data URIs
        const parts = imageSource.split(',');
        if (parts.length === 2) {
            const mimeMatch = parts[0].match(/data:([^;]+);/);
            detectedMimetype = mimeMatch ? mimeMatch[1] : null;
            imageBuffer = Buffer.from(parts[1], 'base64');
        }
    } else {
        // Si viene base64 puro
        imageBuffer = Buffer.from(imageSource, 'base64');
    }

    return { buffer: imageBuffer, mimetype: detectedMimetype };
}

/**
 * Envía campaña de WhatsApp (llamado desde Laravel)
 */
export async function sendCampaign(req, res) {
    try {
        if (!whatsappService.isReady) {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp no está conectado'
            });
        }

        const { phone, message, image, messages } = req.body;

        // Limpiar número
        const numberId = (phone || (messages && messages[0] && messages[0].phone) || '').replace(/\D/g, '');
        if (numberId.length < 10 || numberId.length > 15) {
            return res.status(400).json({ success: false, message: 'Número de teléfono no válido' });
        }
        const jid = await whatsappService.validateNumber(`${numberId}@s.whatsapp.net`);
        if (!jid) return res.status(404).json({ success: false, message: 'Número no registrado' });

        // Función interna para enviar un mensaje individual
        const sendOne = async (msgText, msgImage) => {
            try {
                if (msgImage) {
                    const { buffer, mimetype } = await processImage(msgImage);
                    return await whatsappService.sendImage(jid, buffer, msgText, mimetype);
                }
                return await whatsappService.sendMessage(jid, msgText);
            } catch (err) {
                logger.error('Error enviando mensaje individual en campaña', { error: err.message });
                throw err;
            }
        };

        // Si viene un array de mensajes (Secuencia)
        if (Array.isArray(messages) && messages.length > 0) {
            // Enviamos respuesta inmediata para que Laravel no espere
            res.json({ success: true, message: 'Secuencia de mensajes iniciada' });

            let currentDelay = 0;
            for (const msg of messages) {
                currentDelay += (msg.delay || 0);
                setTimeout(async () => {
                    try {
                        await sendOne(msg.message, msg.image);
                        logger.info('Mensaje de secuencia enviado', { phone: numberId, delay: msg.delay });
                    } catch (e) {
                        logger.error('Fallo en mensaje de secuencia', { error: e.message });
                    }
                }, currentDelay * 60000); // convertir minutos a ms
            }
            return;
        }

        // Si es un mensaje único (Tradicional)
        if (!message) return res.status(400).json({ success: false, message: 'Mensaje obligatorio' });
        
        const result = await sendOne(message, image);
        logger.info('Campaña única enviada correctamente', { phone: numberId });
        res.json(result);

    } catch (error) {
        logger.error('Error al enviar campaña de WhatsApp', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Error al enviar la campaña: ' + error.message
        });
    }
}

