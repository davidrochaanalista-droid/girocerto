// Helpers compartilhados pelos testes de integração. Lê credenciais SEMPRE de
// process.env (carregado a partir do .env na raiz do projeto, gitignored) —
// nunca hardcode nada aqui, este arquivo é commitado.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(
      '.env não encontrado na raiz do projeto. Copie as credenciais do Supabase hospedado ' +
      '(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL) pra ' + envPath
    );
  }
  const parsed = Object.fromEntries(
    fs.readFileSync(envPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) {
    if (!parsed[key]) throw new Error(`Falta ${key} no .env`);
  }
  return parsed;
}

const env = loadEnv();
const TEST_PASSWORD = 'TesteGiroCerto!' + crypto.randomBytes(4).toString('hex');

function newPgClient() {
  return new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

function newAdminClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const admin = newAdminClient();

async function createAuthUser(emailPrefix) {
  const email = `${emailPrefix}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}@teste.girocerto.dev`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createAuthUser(${emailPrefix}): ${error.message}`);
  return { id: data.user.id, email };
}

async function signInAs(email) {
  const c = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  if (error) throw new Error(`signInAs(${email}): ${error.message}`);
  return c;
}

// Registro simples de asserts pra cada arquivo de teste ter seu próprio contador.
function makeReporter(areaName) {
  let pass = 0;
  let fail = 0;
  const failures = [];
  function check(label, cond, extra) {
    if (cond) {
      pass++;
      console.log('  PASS -', label);
    } else {
      fail++;
      failures.push(label);
      console.log('  FAIL -', label, extra !== undefined ? JSON.stringify(extra) : '');
    }
  }
  function summary() {
    console.log(`\n=== [${areaName}] RESULTADO: ${pass} passou, ${fail} falhou ===`);
    return { area: areaName, pass, fail, failures };
  }
  return { check, summary, get pass() { return pass; }, get fail() { return fail; } };
}

// Cleanup: apaga tenants de teste (cascade cuida de entregadores/pedidos/rotas/
// usuarios_loja/alertas/localizacoes/turnos/avaliacoes/tentativas/comprovantes)
// e os auth users criados. Chamar sempre no finally de cada teste.
async function cleanup(pg, tenantIds, authUserIds) {
  for (const id of tenantIds) {
    try {
      await pg.query('delete from tenants where id = $1', [id]);
    } catch (e) {
      console.error('cleanup tenant falhou:', id, e.message);
    }
  }
  // item 52 (27/08/2026): pessoas_entregadoras não é mais alcançada pelo
  // cascade de tenant — identidade do entregador é separada do vínculo por
  // loja de propósito (sobrevive a qualquer 1 tenant específico). Sem isso,
  // TODO teste que cria entregador/turno vaza pessoa+turno pra sempre
  // (achado real: 17 pessoas de teste órfãs, algumas com turno "ativo" há
  // dias, acumuladas de sessões anteriores a este fix). Tem que rodar
  // DEPOIS do delete de tenants acima — antes disso, rotas_entrega (e
  // afins) ainda referenciam o vínculo e bloqueiam o delete da pessoa.
  for (const uid of authUserIds) {
    try {
      await pg.query('delete from pessoas_entregadoras where auth_user_id = $1', [uid]);
    } catch (e) {
      console.error('cleanup pessoa_entregadora falhou:', uid, e.message);
    }
  }
  for (const uid of authUserIds) {
    try {
      await admin.auth.admin.deleteUser(uid);
    } catch (e) {
      console.error('cleanup auth user falhou:', uid, e.message);
    }
  }
}

// item 57 (27/08/2026): item 52 separou entregadores (vínculo por loja) de
// pessoas_entregadoras (identidade) — quase todo teste antigo criava um
// entregador com 1 insert só. `pessoaCampos` vai pra pessoas_entregadoras
// (nome/status/lat/lng/documentos/tipo_veiculo/etc — tudo que não é
// "relação com 1 loja específica"); `vinculoCampos` vai pra entregadores
// (tenant_id/pessoa_id já entram sozinhos; passe só tipo_vinculo,
// aceita_feira, limite_rotas_simultaneas se precisar mudar do default).
async function criarEntregador(pg, tenantId, authUserId, pessoaCampos = {}, vinculoCampos = {}) {
  const pCols = ['auth_user_id', ...Object.keys(pessoaCampos)];
  const pVals = [authUserId, ...Object.values(pessoaCampos)];
  const pPlaceholders = pCols.map((_, i) => `$${i + 1}`).join(',');
  const { rows: [pessoa] } = await pg.query(
    `insert into pessoas_entregadoras (${pCols.join(',')}) values (${pPlaceholders}) returning id`,
    pVals
  );

  const vCols = ['tenant_id', 'pessoa_id', ...Object.keys(vinculoCampos)];
  const vVals = [tenantId, pessoa.id, ...Object.values(vinculoCampos)];
  const vPlaceholders = vCols.map((_, i) => `$${i + 1}`).join(',');
  const { rows: [vinculo] } = await pg.query(
    `insert into entregadores (${vCols.join(',')}) values (${vPlaceholders}) returning id`,
    vVals
  );

  return { pessoaId: pessoa.id, entregadorId: vinculo.id };
}

// turno agora é por pessoa (item 52), não por vínculo.
async function abrirTurno(pg, pessoaId, extra = {}) {
  const cols = ['pessoa_id', ...Object.keys(extra)];
  const vals = [pessoaId, ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const { rows: [turno] } = await pg.query(
    `insert into turnos (${cols.join(',')}) values (${placeholders}) returning id`,
    vals
  );
  return turno.id;
}

module.exports = {
  env,
  admin,
  newPgClient,
  newAdminClient,
  createAuthUser,
  signInAs,
  makeReporter,
  cleanup,
  criarEntregador,
  abrirTurno,
};
