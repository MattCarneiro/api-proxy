/* eslint-disable no-console */
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import ftp from 'basic-ftp';

const {
  FTP_HOST,
  FTP_USER,
  FTP_PASS,
  FTP_FOLDER = '/',
  PORT = 3000,
} = process.env;

/* ---------- paths ---------- */
const COOKIE_FILE  = path.join(process.cwd(), 'cookies.txt');
const COOKIE_MAX   = 24 * 60 * 60 * 1000;      // 24 h
const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/* ---------- utils ---------- */
async function downloadCookies() {
  const c = new ftp.Client(30_000);
  try {
    await c.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
    await c.downloadTo(COOKIE_FILE, `${FTP_FOLDER}/cookies.txt`);
    console.log('⬇️  cookies.txt baixado do FTP');
  } finally { c.close(); }
}

async function ensureCookies({ force = false } = {}) {
  const fresh =
    !force &&
    fs.existsSync(COOKIE_FILE) &&
    Date.now() - fs.statSync(COOKIE_FILE).mtimeMs < COOKIE_MAX;

  if (!fresh) await downloadCookies();
  await sanitizeCookies();           // sempre garante formato válido
}

async function sanitizeCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return;

  const lines = fs.readFileSync(COOKIE_FILE, 'utf8').split('\n');
  const fixed = lines.map(l => {
    const p = l.split('\t');
    if (p.length !== 7) return l;          // cabeçalho ou linha vazia

    /* domínio com "." → flag TRUE */
    if (p[0].startsWith('.') && p[1] === 'FALSE') p[1] = 'TRUE';

    /* expires negativo → 0 */
    if (+p[4] < 0) p[4] = '0';

    return p.join('\t');
  });
  fs.writeFileSync(COOKIE_FILE, fixed.join('\n'), 'utf8');
}

function runYtDlp(url, outfile) {
  return new Promise((resolve, reject) => {
    const cmd =
      `yt-dlp --cookies "${COOKIE_FILE}" ` +
      `-f "bestvideo[height<=360]+bestaudio/best[height<=360]" ` +
      `-o "${outfile}" ${url}`;

    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr);
      console.log(stdout); resolve();
    });
  });
}

/* ---------- Express ---------- */
const app = express();
app.use(express.json());

app.post('/download', async (req, res) => {
  const videoUrl = req.body.url;
  if (!videoUrl) return res.status(400).json({ error: 'URL is required' });

  const id      = uuidv4();
  const pattern = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  try {
    /* tentativa 1 */
    await ensureCookies();
    await runYtDlp(videoUrl, pattern);

  } catch (e1) {
    console.warn('⚠️  Primeira tentativa falhou, atualizando cookies...');
    try {
      /* tentativa 2 com cookies novos */
      await ensureCookies({ force: true });
      await runYtDlp(videoUrl, pattern);
    } catch (e2) {
      console.error(e2);
      return res.status(500).json({ error: 'Falha ao baixar vídeo mesmo após atualizar cookies' });
    }
  }

  /* acha arquivo final (.mp4 ou .webm) */
  const mp4  = path.join(DOWNLOAD_DIR, `${id}.mp4`);
  const webm = path.join(DOWNLOAD_DIR, `${id}.webm`);
  const file = fs.existsSync(webm) ? webm : mp4;
  const url  = `${req.protocol}://${req.get('host')}/downloads/${path.basename(file)}`;

  /* auto‑delete em 30 min */
  setTimeout(() => fs.unlink(file, () => {}), 30 * 60 * 1000);

  res.json({ downloadUrl: url });
});

app.use('/downloads', express.static(DOWNLOAD_DIR));
app.get('/healthz', (_, r) => r.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`video‑downloader ouvindo em ${PORT}`));
