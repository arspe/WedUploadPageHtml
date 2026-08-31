require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Config da variabili d'ambiente (impostale su Render, MAI nel codice)
// ---------------------------------------------------------------------------
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,      // es: https://wedphotoupload.onrender.com/oauth2callback
  GOOGLE_DRIVE_FOLDER_ID,   // ID della cartella Google Drive di destinazione
  GOOGLE_REFRESH_TOKEN,     // valorizzata DOPO il primo login admin (vedi /auth/login)
  WEDDING_TOKEN,            // token segreto passato dal QR code agli invitati
  ADMIN_SECRET,             // password per proteggere /auth/login
  GALLERY_ADMIN_CODE,       // password separata per la "modalità sposi" nella galleria (cancella tutto)
  SESSION_SECRET,
  ALLOWED_ORIGIN,           // es: https://tuonome.github.io (l'indirizzo della pagina GitHub Pages)
} = process.env;

const TOKENS_PATH = path.join(__dirname, 'tokens.json');

// ---------------------------------------------------------------------------
// Client OAuth2 Google
// ---------------------------------------------------------------------------
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Carica un eventuale refresh token già disponibile (env var oppure file locale)
function loadStoredRefreshToken() {
  if (GOOGLE_REFRESH_TOKEN) return GOOGLE_REFRESH_TOKEN;
  if (fs.existsSync(TOKENS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      return data.refresh_token || null;
    } catch (e) {
      console.error('Impossibile leggere tokens.json:', e.message);
    }
  }
  return null;
}

let currentRefreshToken = loadStoredRefreshToken();
if (currentRefreshToken) {
  oauth2Client.setCredentials({ refresh_token: currentRefreshToken });
}

const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: ALLOWED_ORIGIN || '*', // meglio impostare ALLOWED_ORIGIN su Render con l'indirizzo esatto di GitHub Pages
  })
);
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET || 'cambia-questo-valore',
    resave: false,
    saveUninitialized: false,
  })
);
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB per file (video compresi)
});

// ---------------------------------------------------------------------------
// STEP AMMINISTRATORE (voi due, una tantum): autorizzare l'app ad accedere
// al vostro Google Drive. Gli invitati NON passano da qui.
// ---------------------------------------------------------------------------
app.get('/auth/login', (req, res) => {
  if (ADMIN_SECRET && req.query.key !== ADMIN_SECRET) {
    return res.status(403).send('Accesso non autorizzato.');
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',   // necessario per ottenere il refresh_token
    prompt: 'consent',        // forza il rilascio del refresh_token anche se già concesso
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });

  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Codice di autorizzazione mancante.');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (tokens.refresh_token) {
      currentRefreshToken = tokens.refresh_token;
      // Salvataggio locale (comodo in sviluppo; su Render il filesystem non è
      // persistente tra un deploy e l'altro, quindi copiate il valore anche
      // nella variabile d'ambiente GOOGLE_REFRESH_TOKEN, vedi istruzioni sotto).
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
    }

    res.send(`
      <html>
        <body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height:1.5;">
          <h2>✅ Collegamento a Google Drive riuscito!</h2>
          <p>Copia il valore qui sotto e salvalo su Render come variabile d'ambiente
          <code>GOOGLE_REFRESH_TOKEN</code>, così il collegamento resta attivo anche
          dopo un riavvio del servizio:</p>
          <textarea readonly style="width:100%;height:100px;">${tokens.refresh_token || '(refresh token non ricevuto: riprova aprendo /auth/login, Google lo invia solo la prima volta)'}</textarea>
          <p>Fatto questo, puoi chiudere questa pagina. Il sistema di upload è pronto.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Errore durante lo scambio del codice con Google: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// UPLOAD (usato dagli invitati dalla pagina pubblica, nessun login richiesto)
// ---------------------------------------------------------------------------
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  try {
    if (!currentRefreshToken) {
      return res.status(503).json({
        error: 'Il servizio non è ancora collegato a Google Drive. Contattare gli sposi.',
      });
    }

    const providedToken = req.get('X-Wedding-Token') || req.body.token;
    if (WEDDING_TOKEN && providedToken !== WEDDING_TOKEN) {
      return res.status(403).json({ error: 'Link non valido.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nessun file ricevuto.' });
    }

    const uploaderId = (req.body.uploaderId || '').slice(0, 64) || 'sconosciuto';

    const uploaded = [];
    for (const file of req.files) {
      const fileMetadata = {
        name: `${Date.now()}_${file.originalname}`,
        parents: GOOGLE_DRIVE_FOLDER_ID ? [GOOGLE_DRIVE_FOLDER_ID] : undefined,
        appProperties: { uploaderId },
      };
      const media = {
        mimeType: file.mimetype,
        body: Readable.from(file.buffer),
      };

      const driveRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name',
      });

      uploaded.push(driveRes.data.name);
    }

    photosCache = { data: null, expiresAt: 0 };
    res.json({ success: true, count: uploaded.length, files: uploaded });
  } catch (err) {
    console.error('Errore upload:', err);
    res.status(500).json({ error: 'Errore durante il caricamento su Google Drive.' });
  }
});

// ---------------------------------------------------------------------------
// GALLERIA (elenco e visualizzazione dei ricordi già caricati, sola lettura)
// ---------------------------------------------------------------------------

// Piccola cache in memoria: se più invitati aprono la galleria a pochi
// secondi di distanza, evitiamo di richiedere di nuovo tutto a Google Drive
// ogni singola volta. Le foto nuove compaiono comunque entro 30 secondi.
let photosCache = { data: null, expiresAt: 0 };
const PHOTOS_CACHE_MS = 30 * 1000;

// Elenco dei file: solo metadati, niente contenuto (veloce)
app.get('/api/photos', async (req, res) => {
  try {
    if (!currentRefreshToken) {
      return res.status(503).json({
        error: 'Il servizio non è ancora collegato a Google Drive. Contattare gli sposi.',
      });
    }

    const providedToken = req.get('X-Wedding-Token') || req.query.token;
    if (WEDDING_TOKEN && providedToken !== WEDDING_TOKEN) {
      return res.status(403).json({ error: 'Link non valido.' });
    }

    if (photosCache.data && Date.now() < photosCache.expiresAt) {
      return res.json(photosCache.data);
    }

    const q = GOOGLE_DRIVE_FOLDER_ID
      ? `'${GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`
      : `trashed = false`;

    const result = await drive.files.list({
      q,
      orderBy: 'createdTime desc',
      pageSize: 60,
      fields: 'files(id, name, mimeType, createdTime, thumbnailLink, appProperties)',
    });

    const files = (result.data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      isVideo: (f.mimeType || '').startsWith('video/'),
      createdTime: f.createdTime,
      uploaderId: (f.appProperties && f.appProperties.uploaderId) || null,
      // Miniatura già pronta usata da Drive, ridimensionata un po' più
      // grande del default (~220px) per stare bene nella griglia
      thumb: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, '=s400') : null,
    }));

    const payload = { files };
    photosCache = { data: payload, expiresAt: Date.now() + PHOTOS_CACHE_MS };

    res.json(payload);
  } catch (err) {
    console.error('Errore galleria:', err);
    res.status(500).json({ error: 'Errore nel caricamento della galleria.' });
  }
});

// Contenuto di un singolo file a piena risoluzione (usato solo per la vista
// a schermo intero, aperta una foto alla volta): il backend fa da tramite
// verso Drive, così le foto restano private (visibili solo con il
// WEDDING_TOKEN) senza dover rendere pubblica la cartella su Google Drive.
app.get('/api/photos/:id/media', async (req, res) => {
  try {
    if (!currentRefreshToken) return res.status(503).end();

    const providedToken = req.query.token;
    if (WEDDING_TOKEN && providedToken !== WEDDING_TOKEN) return res.status(403).end();

    const meta = await drive.files.get({ fileId: req.params.id, fields: 'mimeType, size' });
    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const totalSize = parseInt(meta.data.size, 10) || undefined;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');

    const requestOptions = { fileId: req.params.id, alt: 'media' };
    const fetchOptions = { responseType: 'stream' };

    // I video hanno bisogno che il server risponda "a blocchi" (Range),
    // altrimenti molti browser (soprattutto su iPhone) si rifiutano di
    // riprodurli tramite un tramite come il nostro backend.
    const range = req.headers.range;
    if (range && totalSize) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        fetchOptions.headers = { Range: `bytes=${start}-${end}` };
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Content-Length', end - start + 1);
      }
    } else if (totalSize) {
      res.setHeader('Content-Length', totalSize);
    }

    const driveRes = await drive.files.get(requestOptions, fetchOptions);
    driveRes.data
      .on('error', (err) => {
        console.error('Errore stream media:', err);
        res.end();
      })
      .pipe(res);
  } catch (err) {
    console.error('Errore media:', err);
    res.status(404).end();
  }
});

// Cancellazione DEFINITIVA di un file (non nel cestino: sparisce subito e
// per sempre). Permessa solo a chi lo ha caricato (stesso uploaderId) o
// agli sposi (GALLERY_ADMIN_CODE).
app.delete('/api/photos/:id', async (req, res) => {
  try {
    if (!currentRefreshToken) return res.status(503).json({ error: 'Non collegato a Drive.' });

    const providedToken = req.get('X-Wedding-Token') || req.query.token;
    if (WEDDING_TOKEN && providedToken !== WEDDING_TOKEN) {
      return res.status(403).json({ error: 'Link non valido.' });
    }

    const isAdmin = GALLERY_ADMIN_CODE && req.get('X-Admin-Secret') === GALLERY_ADMIN_CODE;

    if (!isAdmin) {
      const requesterUploaderId = (req.get('X-Uploader-Id') || '').slice(0, 64);
      const meta = await drive.files.get({ fileId: req.params.id, fields: 'appProperties' });
      const ownerUploaderId = (meta.data.appProperties && meta.data.appProperties.uploaderId) || null;

      if (!requesterUploaderId || !ownerUploaderId || requesterUploaderId !== ownerUploaderId) {
        return res.status(403).json({ error: 'Puoi cancellare solo le foto che hai caricato tu.' });
      }
    }

    await drive.files.delete({ fileId: req.params.id });
    photosCache = { data: null, expiresAt: 0 };

    res.json({ success: true });
  } catch (err) {
    console.error('Errore cancellazione:', err);
    res.status(500).json({ error: 'Errore durante la cancellazione.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, driveCollegato: !!currentRefreshToken });
});

app.listen(PORT, () => {
  console.log(`WedPhotoUpload in ascolto sulla porta ${PORT}`);
});
