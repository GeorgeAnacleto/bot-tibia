const { Client, GatewayIntentBits } = require('discord.js');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CHANNEL_IDS = ['xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'xxxxxxxxxxxxxxxxxxxxxxxxxx'];
const WHOISONLINE_URL = 'https://foxworldserver.com/?subtopic=whoisonline';
const POLL_MS = 15000;
const PER_PLAYER_COOLDOWN_MS = 60000;
const DB_FILE = path.join(__dirname, 'levels.json');

let browser;
let page;
let db = loadDB();

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return { levels: {}, lastSent: {} };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { levels: {}, lastSent: {} };
  }
}

function saveDB(db) {
  try {
    const backup = DB_FILE + '.bak';
    if (fs.existsSync(DB_FILE)) {
      fs.copyFileSync(DB_FILE, backup);
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('âŒ Erro salvando DB:', e.message);
  }
}

function limparTexto(texto) {
  if (!texto) return '';

  texto = String(texto).trim();

  // Remove tags HTML
  texto = texto.replace(/<[^>]*>/g, '');

  // Remove quebras de linha e tabs
  texto = texto.replace(/[\n\r\t]/g, ' ');

  // Remove múltiplos espaços
  texto = texto.replace(/\s+/g, ' ').trim();

  // Remove TODO o bloco CSS (tudo que estão entre ..outfitImg atÃ© o } final)
  texto = texto.replace(/\.\.outfitImg\s*\{[^}]*\}[^a-zA-Z]*/gi, '');

  // Remove TableHeadlineNavigation a (esse lixo especÃ­fico)
  texto = texto.replace(/TableHeadlineNavigation\s+a\s+/gi, '');
  texto = texto.replace(/TableHeadlineNavigation\s+/gi, '');

  // Remove outros padrões em CSS comuns
  texto = texto.replace(/\.\w+\s*\{[^}]*\}/g, '');

  // Remove propriedades CSS soltas
  texto = texto.replace(/(?:width|height|margin|padding|position|top|left|right|bottom|color|background):\s*[^;]+;?/gi, '');

  // Remove valores CSS soltos (px, %, etc)
  texto = texto.replace(/[-]?\d+px/gi, '');
  texto = texto.replace(/[-]?\d+%/gi, '');

  // Remove palavras CSS comuns
  texto = texto.replace(/\b(relative|absolute|fixed|no-repeat|repeat|white|black|push|pull)\b/gi, '');

  // Remove múltiplos espaços novamente
  texto = texto.replace(/\s+/g, ' ').trim();

  // Remove números isolados no inicio/fim (mas mantém números no meio do nome)
  texto = texto.replace(/^\d+\s*/g, '').trim();
  texto = texto.replace(/\s*\d+$/g, '').trim();

  // Remove pontos e chaves soltas
  texto = texto.replace(/[{}.]/g, '');

  // Remove múltiplos espaços uma última vez
  texto = texto.replace(/\s+/g, ' ').trim();

  return texto;
}

async function inicializarBrowser() {
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', () => {});
  page.on('pageerror', () => {});

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  console.log('Browser inicializado');
}

async function verificarBrowser() {
  try {
    await browser.version();
  } catch (e) {
    console.log('Browser morreu, reiniciando...');
    await inicializarBrowser();
  }
}

async function pegarPlayersOnline() {
  await verificarBrowser();

  try {
    console.log('Carregando pagina...');
    await page.goto(WHOISONLINE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.waitForFunction(() => {
      const table = document.querySelector('table');
      return table && table.rows.length > 1;
    }, { timeout: 10000 });

    const html = await page.content();
    const $ = cheerio.load(html);

    let maiorTabela = null;
    let maiorLinhas = 0;

    $('table').each((idx, t) => {
      const rowCount = $(t).find('tr').length;
      const text = $(t).text().toLowerCase();

      if (text.includes('nome') && text.includes('level') && rowCount > maiorLinhas) {
        maiorTabela = t;
        maiorLinhas = rowCount;
      }
    });

    if (!maiorTabela) {
      console.log('Nenhuma tabela válida encontrada!');
      return [];
    }

    console.log(`Tabela encontrada com ${maiorLinhas} linhas\n`);

    const players = [];
    const linhas = $(maiorTabela).find('tr');

    linhas.each((i, el) => {
      if (i === 0) return;

      const tds = $(el).find('td');
      if (tds.length < 4) return;

      // Estratégia 1: Tentar pegar link direto (mais confiavel)
      let nome = $(tds[1]).find('a').first().text().trim();

      // Estratégia 2: Se não achou link, pega texto da célula
      if (!nome || nome.length < 2) {
        nome = $(tds[1]).clone().children().remove().end().text().trim();
      }

      // Estratégia 3: Pega todo o texto da célula
      if (!nome || nome.length < 2) {
        nome = $(tds[1]).text().trim();
      }

      // Limpa o nome
      nome = limparTexto(nome);

      if (!nome || nome.length < 2) return;

      let guild = $(tds[2]).text().trim();
      guild = limparTexto(guild);

      const vocacaoKeywords = ['paladin', 'knight', 'sorcerer', 'druid'];
      if (!guild || guild.length === 0 || vocacaoKeywords.some(v => guild.toLowerCase().includes(v))) {
        guild = 'Sem Guild';
      }

      let vocacao = $(tds[3]).text().trim();
      vocacao = limparTexto(vocacao);

      if (!vocacao || vocacao.length === 0) {
        if (tds.length > 4) {
          vocacao = $(tds[4]).text().trim();
          vocacao = limparTexto(vocacao);
        }
      }

      let level = 0;
      for (let j = tds.length - 1; j >= 0; j--) {
        const texto = $(tds[j]).text().trim();
        const lvl = parseInt(texto, 10);
        if (!Number.isNaN(lvl) && lvl > 0 && lvl < 3000) {
          level = lvl;
          break;
        }
      }

      if (nome.length > 0 && vocacao.length > 0 && level > 0) {
        const jaExiste = players.some(p => p.nome.toLowerCase() === nome.toLowerCase());
        if (!jaExiste) {
          players.push({ nome, guild, vocacao, level });
          console.log(`${nome} | ${guild} | ${vocacao} | Lvl ${level}`);
        }
      }
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Total de players capturados: ${players.length}`);
    console.log(`${'='.repeat(60)}\n`);

    return players;
  } catch (e) {
    console.error('Erro scraping:', e.message);
    return [];
  }
}

async function enviarMensagemParaCanais(client, mensagem) {
  for (const channelId of CHANNEL_IDS) {
    try {
      const canal = await client.channels.fetch(channelId);
      if (canal?.isTextBased()) {
        await canal.send(mensagem);
      }
    } catch (e) {
      console.error(`Erro ao enviar para canal ${channelId}:`, e.message);
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const token = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

if (!token) {
  console.error('ERRO: Token não definido.');
  process.exit(1);
}

client.once('ready', async () => {
  console.log(`Bot online como ${client.user.tag}`);

  await inicializarBrowser();

  async function tick() {
    try {
      const players = await pegarPlayersOnline();

      for (const p of players) {
        const levelAtual = p.level;
        const levelArmazenado = db.levels[p.nome];

        // PRIMEIRA VEZ vendo o player
        if (levelArmazenado === undefined) {
          console.log(`Novo player detectado: ${p.nome} (Level ${levelAtual})`);
          db.levels[p.nome] = levelAtual;
          continue;
        }

        // DETECÇÃO DE DEATH (level diminuiu)
        if (levelAtual < levelArmazenado) {
          const diferenca = levelArmazenado - levelAtual;
          console.log(`${p.nome} morreu! (${levelArmazenado} â†’ ${levelAtual}, perdeu ${diferenca} levels)`);

          // Atualiza para o level atual (permite notificações futuras)
          db.levels[p.nome] = levelAtual;

          // Notificação de death
          const msgDeath = `:skull_crossbones: **${p.nome}** [${p.guild}] (${p.vocacao}) morreu e caiu do level ${levelArmazenado} para ${levelAtual}! (-${diferenca} levels)`;
          await enviarMensagemParaCanais(client, msgDeath);

          continue;
        }

        // DETECÇÃO DE LEVEL UP
        if (levelAtual > levelArmazenado) {
          const last = db.lastSent[p.nome] || 0;

          // Verifica cooldown
          if (Date.now() - last >= PER_PLAYER_COOLDOWN_MS) {
            const msg = `:tada: **${p.nome}** [${p.guild}] (${p.vocacao}) upou do level ${levelArmazenado} para ${levelAtual}!`;
            await enviarMensagemParaCanais(client, msg);
            db.lastSent[p.nome] = Date.now();
            console.log(`Level UP notificado: ${p.nome} (${levelArmazenado} â†’ ${levelAtual})`);
          } else {
            console.log(`${p.nome} upou mas está em cooldown`);
          }

          // Atualiza level
          db.levels[p.nome] = levelAtual;
        }
      }

      saveDB(db);
    } catch (e) {
      console.error('Erro no monitoramento:', e.message);
    }
  }

  await tick();
  setInterval(tick, POLL_MS);

  process.on('SIGINT', async () => {
    console.log('Encerrando...');
    saveDB(db);
    if (browser) await browser.close();
    process.exit(0);
  });
});

client.login(token);
