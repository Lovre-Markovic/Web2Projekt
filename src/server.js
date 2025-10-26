// src/server.js
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import pkg from 'express-openid-connect';
const { auth, requiresAuth } = pkg;
import { auth as jwtAuth } from 'express-oauth2-jwt-bearer';
import { PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';
import { z } from 'zod';

const app = express();
const prisma = new PrismaClient();

// Middlewares
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // /styles.css, /loto.js

// OpenID Connect (Auth0)
app.use(
  auth({
    authRequired: false,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    baseURL: process.env.AUTH0_BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    secret: process.env.SESSION_SECRET,
  })
);

// Dev bypassi (omoguće lokalni rad bez Auth0)
const maybeRequireAuth =
  process.env.DEV_NO_LOGIN === 'true' ? (req, res, next) => next() : requiresAuth();

const m2mJwt = jwtAuth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER,
  tokenSigningAlg: 'RS256',
});
const devBypassM2M =
  process.env.SKIP_M2M_AUTH === 'true' ? (req, res, next) => next() : m2mJwt;

// Helpers for DB
const getOpenRound = () =>
  prisma.round.findFirst({ where: { isOpen: true }, include: { draw: true } });
const getLastRound = () =>
  prisma.round.findFirst({ orderBy: { id: 'desc' }, include: { draw: true } });

// ========== ROUTES ==========

// Home
app.get('/', async (req, res) => {
  const round = await getOpenRound();
  const last = await getLastRound();
  const open = !!round;
  const ticketsCount = open ? await prisma.ticket.count({ where: { roundId: round.id } }) : null;
  const drawNumbers = !open && last?.draw ? last.draw.numbers : null;

  res.send(`
  <!doctype html>
  <html lang="hr">
  <head>
    <meta charset="utf-8" />
    <title>Web2Projekt — Loto 6/45</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h1>Web2Projekt — Loto 6/45</h1>
        <p>${
          req.oidc.isAuthenticated()
            ? `Prijavljen: ${req.oidc.user?.email} — <a href="/logout">Odjava</a>`
            : `<a href="/login">Prijava</a>`
        }</p>
        <hr/>
        <p>Uplate: ${open ? '<b style="color:lime">AKTIVNE</b>' : '<b style="color:#f66">NEAKTIVNE</b>'}</p>
        <p>Uplaćeni listići (trenutno kolo): ${ticketsCount ?? '—'}</p>
        <p>Izvučeni brojevi: ${drawNumbers ?? '—'}</p>
        ${open ? '<p><a class="button" href="/ticket">Uplati listić</a></p>' : ''}
      </div>
      <div class="footer">© ${new Date().getFullYear()} Web2Projekt</div>
    </div>
  </body>
  </html>
  `);
});

// Uplata form
app.get('/ticket', maybeRequireAuth, async (req, res) => {
  const round = await getOpenRound();
  if (!round) return res.status(403).send('Uplate nisu aktivne.');

  res.send(`
  <!doctype html>
  <html lang="hr">
  <head>
    <meta charset="utf-8" />
    <title>Uplata listića — Loto 6/45</title>
    <link rel="stylesheet" href="/styles.css">
    <script defer src="/loto.js"></script>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h2>Uplata listića</h2>
        <div class="row">
          <form class="form" method="POST" action="/tickets">
            <label class="label">Broj osobne/putovnice (max 20 znakova)</label>
            <input class="input" name="personalId" required placeholder="npr. AB123456" />

            <label class="label">Brojevi (6–10 u rasponu 1–45, odvojeni zarezom)</label>
            <input class="input" name="numbers" placeholder="1,2,3,4,5,6" required />

            <button class="button" type="submit">Uplati listić</button>
            <a class="button" href="/">Natrag</a>
          </form>

          <div class="loto-anim">
            <div class="loto-bubanj"></div>
          </div>
        </div>
      </div>
      <div class="footer">© ${new Date().getFullYear()} Web2Projekt</div>
    </div>
  </body>
  </html>
  `);
});

// Validacija ulaza (po zadatku)
const ticketSchema = z.object({
  personalId: z
    .string()
    .min(1, 'Osobna/putovnica je obavezna.')
    .max(20, 'Predugačak broj dokumenta.')
    .regex(/^[A-Za-z0-9]+$/, 'Smiju biti samo slova i brojke.'), // (do 20 znakova)
  numbers: z.string().transform((s) => {
    const arr = s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map(Number);
    if (arr.length < 6 || arr.length > 10)
      throw new Error('Mora biti od 6 do 10 brojeva.');
    if (arr.some((n) => !Number.isInteger(n) || n < 1 || n > 45))
      throw new Error('Svi brojevi moraju biti cijeli između 1 i 45.');
    if (new Set(arr).size !== arr.length)
      throw new Error('Ne smije biti duplikata.');
    return arr;
  }),
});

// POST /tickets – stvori listić i vrati QR (image/png)
app.post('/tickets', maybeRequireAuth, async (req, res) => {
  const openRound = await getOpenRound();
  if (!openRound) return res.status(403).send('Uplate nisu aktivne.');

  try {
    const parsed = ticketSchema.parse({
      personalId: req.body.personalId,
      numbers: req.body.numbers,
    });

    const ticket = await prisma.ticket.create({
      data: {
        personalId: parsed.personalId,
        numbersCsv: parsed.numbers.join(','),
        roundId: openRound.id,
        userSub: req.oidc?.user?.sub || null,
      },
    });

    const publicUrl = `${process.env.BASE_URL}/t/${ticket.id}`;
    const png = await QRCode.toBuffer(publicUrl, { type: 'png' });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Location', publicUrl); // praktično za test
    console.log('🎟️ Novi listić:', publicUrl);
    res.end(png);
  } catch (e) {
    res.status(400).send(e?.message || 'Neispravni podaci.');
  }
});

// GET /t/:id – javno, prikaz listića + izvučeni brojevi
app.get('/t/:id', async (req, res) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: { round: { include: { draw: true } } },
  });
  if (!ticket) return res.status(404).send('Listić nije pronađen.');

  const nums = ticket.numbersCsv.split(',').map((n) => Number(n));
  const draw = ticket.round.draw?.numbers
    ? ticket.round.draw.numbers.split(',').map((n) => Number(n))
    : [];

  res.send(`
  <!doctype html>
  <html lang="hr">
  <head>
    <meta charset="utf-8" />
    <title>Listić ${ticket.id}</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h2>Listić <span class="mono">${ticket.id}</span></h2>
        <p><b>Osobni broj:</b> ${ticket.personalId}</p>
        <p><b>Tvoji brojevi:</b> ${nums.join(', ')}</p>
        <p><b>Izvučeni brojevi:</b> ${draw.length ? draw.join(', ') : '— još nisu objavljeni —'}</p>
        <a class="button" href="/">Početna</a>
      </div>
      <div class="footer">© ${new Date().getFullYear()} Web2Projekt</div>
    </div>
  </body>
  </html>
  `);
});

// ===== Admin endpoints (OAuth2 Client Credentials) =====
// Točna semantika po zadatku (status 204/400)
app.post('/new-round', devBypassM2M, async (_req, res) => {
  const current = await getOpenRound();
  if (current) return res.status(204).end(); // već aktivno
  await prisma.round.updateMany({ where: { isOpen: true }, data: { isOpen: false } });
  await prisma.round.create({ data: { isOpen: true } }); // novo kolo
  res.status(204).end();
});

app.post('/close', devBypassM2M, async (_req, res) => {
  const current = await getOpenRound();
  if (!current) return res.status(204).end(); // već zatvoreno / nema kola
  await prisma.round.update({ where: { id: current.id }, data: { isOpen: false } });
  res.status(204).end();
});

app.post('/store-results', devBypassM2M, async (req, res) => {
  const { numbers } = req.body || {};
  const open = await getOpenRound();
  if (open?.isOpen) return res.status(400).send('Uplate su aktivne.');
  const last = await getLastRound();
  if (!last) return res.status(400).send('Nema evidentiranih kola.');
  if (last.draw) return res.status(400).send('Rezultati već postoje.');
  if (!Array.isArray(numbers)) return res.status(400).send('Nedostaje polje "numbers".');

  await prisma.draw.create({ data: { roundId: last.id, numbers: numbers.join(',') } });
  res.status(204).end();
});

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server radi na http://localhost:${port}`));
