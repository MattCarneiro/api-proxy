const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const TMP_DIR = path.join(__dirname, 'tmp');
const DECODED_DIR = path.join(__dirname, 'decoded');
const FILE_LIFETIME_MS = 30 * 60 * 1000; // 30 minutos em milissegundos

if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR);
}
if (!fs.existsSync(DECODED_DIR)) {
    fs.mkdirSync(DECODED_DIR);
}

function HKDF(key, length, appInfo = "") {
    const keyBuffer = crypto.createHmac('sha256', Buffer.alloc(32, 0)).update(key).digest();
    let keyStream = Buffer.alloc(0);
    let keyBlock = Buffer.alloc(0);
    let blockIndex = 1;

    while (keyStream.length < length) {
        keyBlock = crypto.createHmac('sha256', keyBuffer)
            .update(Buffer.concat([keyBlock, Buffer.from(appInfo), Buffer.from([blockIndex])]))
            .digest();
        blockIndex += 1;
        keyStream = Buffer.concat([keyStream, keyBlock]);
    }

    return keyStream.slice(0, length);
}

function AESUnpad(buffer) {
    const pad = buffer[buffer.length - 1];
    return buffer.slice(0, buffer.length - pad);
}

function AESDecrypt(key, ciphertext, iv) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return AESUnpad(decrypted);
}

async function downloadAndDecrypt(payload) {
    const { url, mediaKey, messageType, whatsappTypeMessageToDecode, mimetype } = payload;

    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const mediaData = Buffer.from(response.data);
    const filename = `${Date.now()}.enc`;

    const mediaKeyExpanded = HKDF(Buffer.from(mediaKey, 'base64'), 112, whatsappTypeMessageToDecode);
    const fileData = mediaData.slice(0, -10);

    const decryptedData = AESDecrypt(
        mediaKeyExpanded.slice(16, 48),
        fileData,
        mediaKeyExpanded.slice(0, 16)
    );

    const extension = mimetype.split('/')[1];
    const decodedFilename = `${Date.now()}.${extension}`;
    const filePath = path.join(DECODED_DIR, decodedFilename);

    fs.writeFileSync(filePath, decryptedData);
    return decodedFilename;
}

function deleteOldFiles() {
    const now = Date.now();

    fs.readdir(DECODED_DIR, (err, files) => {
        if (err) {
            console.error('Erro ao ler diretório:', err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(DECODED_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error('Erro ao obter informações do arquivo:', err);
                    return;
                }

                if (now - stats.mtimeMs > FILE_LIFETIME_MS) {
                    fs.unlink(filePath, err => {
                        if (err) {
                            console.error('Erro ao deletar arquivo:', err);
                        } else {
                            console.log(`Arquivo deletado: ${file}`);
                        }
                    });
                }
            });
        });
    });
}

app.post('/decrypt', async (req, res) => {
    try {
        const payload = req.body;
        const decodedFilename = await downloadAndDecrypt(payload);
        const fileUrl = `${req.protocol}://${req.get('host')}/decoded/${decodedFilename}`;
        res.json({ fileUrl });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to decrypt the file' });
    }
});

app.use('/decoded', express.static(DECODED_DIR));

// Configuração para apagar arquivos antigos a cada 30 minutos
setInterval(deleteOldFiles, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
