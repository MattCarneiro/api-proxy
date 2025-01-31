const express = require('express');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const fetch = require('node-fetch');
const sharp = require('sharp');
const path = require('path');
const axios = require('axios');
const amqp = require('amqplib/callback_api');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Substitua pela sua chave de API do Google Drive
const API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const BACKOFF_RETRIES = parseInt(process.env.BACKOFF_RETRIES, 10) || 7;

// Diretório para armazenar os PDFs publicamente acessíveis
const pdfStoragePath = './public/';
if (!fs.existsSync(pdfStoragePath)) {
    fs.mkdirSync(pdfStoragePath, { recursive: true });
}

// Configurando a pasta 'public' como estática
app.use(express.static('public'));
app.use(express.json());

// Configurações do RabbitMQ
const RABBITMQ_HOST = process.env.RABBITMQ_HOST;
const RABBITMQ_PORT = process.env.RABBITMQ_PORT;
const RABBITMQ_USER = process.env.RABBITMQ_USER;
const RABBITMQ_PASS = process.env.RABBITMQ_PASS;
const RABBITMQ_VHOST = process.env.RABBITMQ_VHOST;
const QUEUE_TYPE = process.env.RABBITMQ_QUEUE_TYPE;  // Tipo da fila (lazy ou quorum)
let QUEUE_NAME = process.env.QUEUE_NAME;  // Nome base da fila
const PREFETCH_COUNT = parseInt(process.env.PREFETCH_COUNT, 10); // Prefetch Count configurável
const PROXY_TOKEN = process.env.PROXY_TOKEN;

let connection;
let channel;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10; // Número máximo de tentativas de reconexão
const initialReconnectDelay = 1000; // Tempo inicial de espera antes de tentar reconectar (em ms)

function connectToRabbitMQ() {
    amqp.connect({
        protocol: 'amqp',
        hostname: RABBITMQ_HOST,
        port: RABBITMQ_PORT,
        username: RABBITMQ_USER,
        password: RABBITMQ_PASS,
        vhost: RABBITMQ_VHOST,
    }, function (err, conn) {
        if (err) {
            console.error('[AMQP] Error connecting:', err.message);
            return reconnect();
        }

        conn.on('error', function (err) {
            if (err.message !== 'Connection closing') {
                console.error('[AMQP] Connection error:', err.message);
            }
        });

        conn.on('close', function () {
            console.error('[AMQP] Connection closed, reconnecting...');
            return reconnect();
        });

        console.log('[AMQP] Connected');
        connection = conn;
        startConsumer();
    });
}

function reconnect() {
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(Math.pow(2, reconnectAttempts) * initialReconnectDelay, 30000); // Backoff exponencial até 30 segundos
        console.log(`[AMQP] Reconnecting in ${delay} ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
        setTimeout(() => {
            connectToRabbitMQ();
        }, delay);
    } else {
        console.error('[AMQP] Max reconnection attempts reached');
    }
}

function startConsumer() {
    connection.createChannel(function (err, ch) {
        if (closeOnErr(err)) return;
        ch.on('error', function (err) {
            console.error('[AMQP] Channel error:', err.message);
        });
        ch.on('close', function () {
            console.log('[AMQP] Channel closed');
            return reconnect();
        });
        channel = ch;

        // Prepara o consumidor
        channel.consume(QUEUE_NAME, async (msg) => {
            try {
                await processPdfCreation(msg);
            } catch (error) {
                // Em caso de erro, rejeita a mensagem sem reencaminhar
                console.error('Erro ao processar a mensagem:', error);
                channel.nack(msg, false, false);
            }
        }, { noAck: false });

        console.log('[AMQP] Consumer started');
        reconnectAttempts = 0; // Reseta o contador de tentativas de reconexão
    });
}

function closeOnErr(err) {
    if (!err) return false;
    console.error('[AMQP] Error:', err);
    connection.close();
    return true;
}

async function fetchWithExponentialBackoff(url, options, retries = BACKOFF_RETRIES) {
    let retryCount = 0;
    const maxBackoff = 32000; // 32 segundos

    while (retryCount < retries) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
            }
            return res;
        } catch (error) {
            const waitTime = Math.min(Math.pow(2, retryCount) * 1000 + Math.floor(Math.random() * 1000), maxBackoff);
            console.log(`Retrying in ${waitTime} ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            retryCount++;
        }
    }
    throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

async function downloadImage(fileUrl, filePath, index, total) {
    const res = await fetchWithExponentialBackoff(fileUrl, {}, BACKOFF_RETRIES); // Define tentativas configuráveis via env
    const buffer = await res.buffer();
    fs.writeFileSync(filePath, buffer);
    console.log(`Imagem ${index + 1}/${total} baixada (${Math.round(((index + 1) / total) * 100)}%)`);
}

async function getImageUrlsFromFolder(folderId) {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+(mimeType='image/jpeg'+or+mimeType='image/png'+or+mimeType='image/webp')&key=${API_KEY}&fields=files(id,name,mimeType)`;
    const res = await fetchWithExponentialBackoff(url, {}, BACKOFF_RETRIES); // Define tentativas configuráveis via env
    const data = await res.json();
    if (!data.files || data.files.length === 0) {
        throw new Error('Nenhuma imagem encontrada na pasta especificada.');
    }
    return data.files.map(file => ({
        url: `https://drive.google.com/uc?id=${file.id}`,
        name: file.name
    }));
}

async function processPdfCreation(msg, attempt = 0, log = '') {
    const { link, Id, context, UserMsg, MsgIdPhoto, MsgIdVideo, MsgIdPdf } = JSON.parse(msg.content.toString());

    try {
        const isFolderLink = link.includes('/folders/');
        const folderIdOrFileId = extractIdFromLink(link);
        let images = [];

        if (isFolderLink) {
            images = await getImageUrlsFromFolder(folderIdOrFileId);
        } else {
            const imageUrl = `https://drive.google.com/uc?id=${folderIdOrFileId}`;
            images = [{ url: imageUrl, name: 'downloaded_image' }];
        }

        if (images.length === 0) {
            throw new Error('Nenhuma imagem encontrada na pasta ou arquivo especificado.');
        }

        const imagePaths = [];
        for (let i = 0; i < images.length; i++) {
            const imagePath = path.join(__dirname, `${images[i].name}`);
            await downloadImage(images[i].url, imagePath, i, images.length);
            imagePaths.push(imagePath);
        }

        const pdfBytes = await createPDFWithImages(imagePaths);
        const pdfName = `pdf_${Date.now()}.pdf`;
        fs.writeFileSync(`${pdfStoragePath}${pdfName}`, pdfBytes);

        // Remove as imagens temporárias
        for (const imagePath of imagePaths) {
            fs.unlinkSync(imagePath);
        }

        console.log(`PDF criado com sucesso: ${pdfName}`);

        // Agendar para apagar o PDF após 15 minutos
        setTimeout(() => {
            fs.unlink(`${pdfStoragePath}${pdfName}`, (err) => {
                if (err) {
                    console.error(`Erro ao apagar o PDF (${pdfName}):`, err);
                } else {
                    console.log(`PDF (${pdfName}) apagado com sucesso.`);
                }
            });
        }, 900000); // 900000 milissegundos = 15 minutos

        // Enviar webhook ao finalizar o processo
        await axios.post('https://ultra-n8n.neuralbase.com.br/webhook/fotos-motel', {
            pdfName,
            Id,
            context,
            UserMsg,
            MsgIdPhoto,
            MsgIdVideo,
            MsgIdPdf,
            link,
            result: true
        }).then(() => {
            console.log(`Webhook enviado sem erros`);
        }).catch(error => {
            console.error(`Erro ao enviar webhook: ${error}`);
        });

        channel.ack(msg);
    } catch (error) {
        console.error('Erro ao criar o PDF:', error);
        log += `Erro ao criar o PDF: ${error.message}\n    at ${error.stack}\n`;

        if (attempt < BACKOFF_RETRIES) {
            const waitTime = Math.min(Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000), 32000);
            console.log(`Retrying processPdfCreation in ${waitTime} ms... (attempt ${attempt + 1}/${BACKOFF_RETRIES})`);
            setTimeout(() => processPdfCreation(msg, attempt + 1, log), waitTime);
        } else {
            // Enviar webhook em caso de erro após todas as tentativas
            await axios.post('https://ultra-n8n.neuralbase.com.br/webhook/fotos-motel', {
                pdfName: null,
                Id,
                context,
                UserMsg,
                MsgIdPhoto,
                MsgIdVideo,
                MsgIdPdf,
                link,
                result: false,
                reason: log
            }).then(() => {
                console.log(`Webhook enviado com erros`);
            }).catch(error => {
                console.error(`Erro ao enviar webhook: ${error}`);
            });

            channel.nack(msg, false, false); // Rejeita a mensagem sem reencaminhar
        }
    }
}

function extractIdFromLink(link) {
    const fileIdMatch = link.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const folderIdMatch = link.match(/\/folders\/([a-zA-Z0-9-_]+)/);
    const idParamMatch = link.match(/id=([a-zA-Z0-9-_]+)/);

    if (fileIdMatch) {
        return fileIdMatch[1];
    } else if (folderIdMatch) {
        return folderIdMatch[1];
    } else if (idParamMatch) {
        return idParamMatch[1];
    } else {
        return link.split('/').pop().split('?')[0];
    }
}

async function createPDFWithImages(imagePaths) {
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < imagePaths.length; i++) {
        const imagePath = imagePaths[i];

        if (!fs.existsSync(imagePath)) {
            throw new Error(`File not found: ${imagePath}`);
        }

        const imageBytes = fs.readFileSync(imagePath);
        let img;
        const imgType = path.extname(imagePath).toLowerCase();

        if (imgType === '.webp') {
            const pngBuffer = await sharp(imageBytes).png().toBuffer();
            img = await pdfDoc.embedPng(pngBuffer);
        } else if (imgType === '.jpg' || imgType === '.jpeg') {
            img = await pdfDoc.embedJpg(imageBytes);
        } else if (imgType === '.png') {
            img = await pdfDoc.embedPng(imageBytes);
        } else {
            throw new Error(`Unsupported image type: ${imgType}`);
        }

        const { width, height } = img;
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(img, {
            x: 0,
            y: 0,
            width,
            height
        });
        console.log(`Imagem ${i + 1}/${imagePaths.length} adicionada ao PDF (${Math.round(((i + 1) / imagePaths.length) * 100)}%)`);
    }
    return await pdfDoc.save();
}

// Inicia a conexão com o RabbitMQ
connectToRabbitMQ();

app.post('/create-pdf', (req, res) => {
    const { link, Id, context, UserMsg, MsgIdPhoto, MsgIdVideo, MsgIdPdf } = req.body;

    if (!link || !Id) {
        return res.status(400).send('Parâmetros ausentes: link e Id são necessários.');
    }

    const msg = { link, Id, context, UserMsg, MsgIdPhoto, MsgIdVideo, MsgIdPdf };
    if (channel) {
        channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(msg)), {
            persistent: true
        });

        console.log('Mensagem enviada para a fila');
        res.send({ message: 'Iniciando criação do PDF.' });
    } else {
        console.error('Canal não estabelecido');
        res.status(500).send('Canal RabbitMQ não está disponível.');
    }
});

app.get('/download', (req, res) => {
    const { pdfName } = req.query;

    if (!pdfName) {
        return res.status(400).send('Nome do PDF não especificado.');
    }

    const filePath = path.join(pdfStoragePath, pdfName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('PDF não encontrado.');
    }

    res.download(filePath, pdfName, (err) => {
        if (err) {
            console.error(`Erro ao baixar o PDF (${pdfName}):`, err);
            res.status(500).send('Erro ao baixar o PDF.');
        }
    });
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});
