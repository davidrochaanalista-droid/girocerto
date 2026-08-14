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
  for (const uid of authUserIds) {
    try {
      await admin.auth.admin.deleteUser(uid);
    } catch (e) {
      console.error('cleanup auth user falhou:', uid, e.message);
    }
  }
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
};
