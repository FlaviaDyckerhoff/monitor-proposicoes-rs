const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALRS';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const API_URL = 'https://ww4.al.rs.gov.br:5000/listaProposicaoCompleto';

// A API da ALRS fica instável às vezes. Tentamos com folga para evitar falso negativo.
const MAX_TENTATIVAS = 5;
const ESPERA_ENTRE_TENTATIVAS_MS = 20000;
const DETAIL_BASE_URL = 'https://www.al.rs.gov.br/proposicao';
const STATUS_SEM_EMENTA = new Set(['autuado(a)', 'entrada', 'aprovado(a)']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(str) {
  return (str || '').toString()
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function montarUrlProposicao(p) {
  const tipo = encodeURIComponent(p.tipo || p.siglaTipoProposicao || p.sigla || '');
  const numero = encodeURIComponent(p.numero || p.nroProposicao || p.nro || '');
  const ano = encodeURIComponent(p.ano || p.anoProposicao || '');
  if (!tipo || !numero || !ano) return DETAIL_BASE_URL;
  return DETAIL_BASE_URL + '/' + tipo + '/' + numero + '/' + ano;
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = String(p?.tipo ?? p?.sigla ?? p?.rotulo ?? '').trim();
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || p?.natureza || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const atual = porTipo.get(tipo);
    if (!atual || partes.numeroInt > atual.numeroInt) {
      porTipo.set(tipo, {
        tipo,
        numeroInt: partes.numeroInt,
        numero: partes.numero,
        ano: partes.ano || String(p?.ano || p?.ano_proposicao || ''),
        ementa: String(p?.ementa || p?.resumo || p?.assunto || '').trim(),
        link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
        clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      });
    }
  });
  return Array.from(porTipo.values());
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      let item = casa.items.find(i => String(i?.tipo || '').toUpperCase() === rec.tipo);
      if (!item) {
        item = { tipo: rec.tipo, base: 0, mon: rec.numeroInt };
        casa.items.push(item);
      }
      const base = Number.parseInt(String(item.base || item.mon || 0), 10) || 0;
      item.tipo = rec.tipo;
      item.mon = rec.numeroInt;
      item.delta = Math.abs(rec.numeroInt - base);
      item.sentido = rec.numeroInt === base ? 'bate com o controle' : 'fonte/sistema acima';
      item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
      item.ementa = rec.ementa || item.ementa || '';
      item.link = rec.link || item.link || '';
      item.clienteSugestao = rec.clienteSugestao || item.clienteSugestao || '';
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  anotarClientesCitados(novas);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  // Agrupa por tipo
  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${escapeHtml(p.tipo || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><a href="${p.url}" style="color:#003366;text-decoration:none"><strong>${escapeHtml(p.numero || '-')}/${escapeHtml(p.ano || '-')}</strong></a></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${escapeHtml(p.autor || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${escapeHtml(p.data || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ Assembleia Legislativa do Rio Grande do Sul — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://ww4.al.rs.gov.br/legislativo">ww4.al.rs.gov.br/legislativo</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Rio Grande do Sul" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Rio Grande do Sul: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

async function buscarProposicoes() {
  const ano = String(new Date().getFullYear());

  // Body idêntico ao que o frontend da ALRS envia.
  // siglaTipoProposicao vazio = todos os tipos.
  const body = {
    anoProposicao: ano,
    assunto1: "",
    assunto2: "",
    assunto3: "",
    codProponente: "",
    dataFim: "",
    dataIni: "",
    nomeProponente: "",
    nroProcesso: "",
    nroProposicao: "",
    page: 1,
    pageSize: 1000,
    proposicaoPaiId: "",
    siglaTipoProposicao: "",
    situacaoProposicao: "",
    tipoProponente: ""
  };

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    console.log(`🔍 Buscando proposições de ${ano}... (tentativa ${tentativa}/${MAX_TENTATIVAS})`);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://ww4.al.rs.gov.br/',
          'Origin': 'https://ww4.al.rs.gov.br'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000) // timeout de 60s
      });

      if (!response.ok) {
        console.error(`❌ Erro na API: ${response.status} ${response.statusText}`);
        const texto = await response.text();
        console.error('Resposta:', texto.substring(0, 300));
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      console.log('📦 Resposta da API (estrutura):', JSON.stringify(json).substring(0, 300));

      // Tenta extrair a lista de proposições de vários campos possíveis
      const lista = Array.isArray(json) ? json :
                    json.content ? json.content :
                    json.data ? json.data :
                    json.lista ? json.lista :
                    json.proposicoes ? json.proposicoes :
                    json.resultado ? json.resultado : [];

      console.log(`📊 ${lista.length} proposições recebidas`);
      return lista;

    } catch (err) {
      console.error(`⚠️ Tentativa ${tentativa} falhou: ${err.message}`);
      if (tentativa < MAX_TENTATIVAS) {
        console.log(`⏳ Aguardando ${ESPERA_ENTRE_TENTATIVAS_MS / 1000}s antes de tentar novamente...`);
        await sleep(ESPERA_ENTRE_TENTATIVAS_MS);
      }
    }
  }

  throw new Error('Todas as tentativas falharam. API da ALRS instavel.');
}

function gerarId(p) {
  // Tenta campo de ID direto, depois monta a partir de tipo+numero+ano
  return p.id || p.codigo || p.idProposicao || p.proposicaoId ||
    `${p.siglaTipoProposicao || p.sigla || p.tipo || ''}-${p.nroProposicao || p.numero || ''}-${p.anoProposicao || p.ano || ''}-${p.nomeProponente || ''}`.replace(/\s/g, '');
}

function montarLinkProposicao(tipo, numero, ano) {
  if (!tipo || !numero || !ano || tipo === '-' || numero === '-' || ano === '-') {
    return 'https://www.al.rs.gov.br/legislativo';
  }
  return `${DETAIL_BASE_URL}/${encodeURIComponent(tipo)}/${encodeURIComponent(numero)}/${encodeURIComponent(ano)}`;
}

function limparTextoHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&aacute;/g, 'á')
    .replace(/&agrave;/g, 'à')
    .replace(/&acirc;/g, 'â')
    .replace(/&atilde;/g, 'ã')
    .replace(/&eacute;/g, 'é')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&ocirc;/g, 'ô')
    .replace(/&otilde;/g, 'õ')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ccedil;/g, 'ç')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairEmentaDaPagina(html) {
  const match = html.match(/<div[^>]+id=["']content-ementa["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!match) return '';
  return limparTextoHtml(match[1]).replace(/^Ementa\s*/i, '').trim();
}

async function buscarEmentaDetalhe(tipo, numero, ano) {
  const link = montarLinkProposicao(tipo, numero, ano);

  try {
    const response = await fetch(link, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    return extrairEmentaDaPagina(html);
  } catch (err) {
    console.warn(`⚠️ Não foi possível buscar ementa em ${link}: ${err.message}`);
    return '';
  }
}

async function normalizarProposicao(p) {
  // Campos observados no payload da ALRS: siglaTipoProposicao, nroProposicao,
  // anoProposicao, nomeProponente, dataApresentacao.
  // O campo descricao é situação/tramitação ("Autuado(a)", "Entrada" etc.),
  // não ementa. A ementa correta vem da página pública de detalhe.
  const tipo = p.siglaTipoProposicao || p.sigla || p.tipo || '-';
  const numero = p.nroProposicao || p.numero || p.nro || '-';
  const ano = p.anoProposicao || p.ano || '-';
  const autor = p.nomeProponente || p.autor || p.nomeAutor || p.autores || '-';
  const data = p.dataApresentacao || p.dthProtocolo || p.dataEntrada || p.data || '-';
  const url = montarUrlProposicao({ tipo, numero, ano });
  const ementaApi = (p.ementa || p.descricaoProposicao || p.descricao || '').trim();
  const ementa = STATUS_SEM_EMENTA.has(ementaApi.toLowerCase()) ? '-' : (ementaApi || '-');

  return {
    id: gerarId(p),
    tipo,
    numero,
    ano,
    autor,
    data,
    ementa,
    situacao: p.descricao || p.situacao || p.situacaoProposicao || '-',
    url,
  };
}

function extrairEmentaDetalhe(html) {
  const match = html.match(/<div[^>]+id=["']content-ementa["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return null;
  return stripHtml(match[1]);
}

async function enriquecerEmentaDetalhe(p) {
  if (!p.url || p.url === DETAIL_BASE_URL) return p;

  try {
    const response = await fetch(p.url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': DETAIL_BASE_URL,
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ementa = extrairEmentaDetalhe(await response.text());
    if (ementa) p.ementa = ementa;
  } catch (err) {
    console.warn(`⚠️ Não consegui enriquecer ementa de ${p.tipo} ${p.numero}/${p.ano}: ${err.message}`);
  }

  return p;
}

async function enriquecerEmentasDetalhe(proposicoes) {
  for (const p of proposicoes) {
    await enriquecerEmentaDetalhe(p);
    await sleep(250);
  }
}

(async () => {
  console.log('🚀 Iniciando monitor ALRS...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    throw new Error('Nenhuma proposicao encontrada. API pode estar fora do ar.');
  }

  const proposicoes = (await Promise.all(proposicoesRaw.map(normalizarProposicao))).filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enriquecerEmentasDetalhe(novas);

    // Ordena por tipo alfabético, depois por número decrescente dentro de cada tipo
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });
    await sincronizarRadar03(novas);
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
