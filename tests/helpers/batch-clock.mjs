import assert from 'node:assert/strict';

// Never fall back to DATABASE_URL. The caller supplies the expected database
// identity from its explicit suite URL; CI and local database names may differ.
export function batchDatabaseTarget(value){
  if(!value)throw Error('Explicit disposable TEST_BATCH_DATABASE_URL ending _test required.');
  let parsed;
  try{parsed=new URL(value);}catch{throw Error('TEST_BATCH_DATABASE_URL must be a PostgreSQL URL.');}
  const expected=decodeURIComponent(parsed.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(parsed.protocol)||!parsed.hostname||! /^[A-Za-z0-9_]+_test$/.test(expected)){
    throw Error('TEST_BATCH_DATABASE_URL must name an explicit PostgreSQL database ending _test.');
  }
  return {url:value,expected};
}

export async function assertBatchDatabase(pool,expected,{fresh=false}={}){
  assert.match(expected,/^[A-Za-z0-9_]+_test$/);
  const actual=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(actual,expected,'Actual database must exactly match the explicitly requested test database.');
  if(fresh){
    const {rows}=await pool.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
      AND c.relkind IN ('r','p','v','m','f','S')`);
    assert.equal(rows.length,0,'Batch suite requires a fresh empty disposable database; provision a new _test database, never reset an existing target.');
  }else{
    const identity=await pool.query('SELECT purpose FROM public.database_identity');
    assert.deepEqual(identity.rows,[{purpose:'test'}],'Clock DDL requires an existing purpose=test provisioning marker.');
  }
}

export async function installBatchClock(pool,expected,initial){
  await assertBatchDatabase(pool,expected);
  const {rows:[definition]}=await pool.query(`SELECT pg_get_functiondef('public.fp_settlement_clock()'::regprocedure) AS ddl,
    p.provolatile,p.prosecdef FROM pg_proc p WHERE p.oid='public.fp_settlement_clock()'::regprocedure`);
  assert.equal(definition.provolatile,'v');assert.equal(definition.prosecdef,false);
  // Keep the exact original definition, including schema/search-path settings.
  let tableCreated=false,replaced=false;
  async function restore(){
    if(replaced){await pool.query(definition.ddl);replaced=false;}
    if(tableCreated){await pool.query('DROP TABLE public.fp_a06_test_clock');tableCreated=false;}
  }
  try{
    await pool.query('CREATE TABLE public.fp_a06_test_clock(singleton boolean PRIMARY KEY CHECK(singleton), instant timestamptz NOT NULL)');tableCreated=true;
    await pool.query('INSERT INTO public.fp_a06_test_clock VALUES (true,$1::timestamptz)',[initial]);
    await pool.query(`CREATE OR REPLACE FUNCTION public.fp_settlement_clock() RETURNS timestamptz
      LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
      AS $$ SELECT instant FROM public.fp_a06_test_clock WHERE singleton $$`);replaced=true;
  }catch(error){await restore();throw error;}
  return {
    async set(instant){
      const result=await pool.query('UPDATE public.fp_a06_test_clock SET instant=$1::timestamptz WHERE singleton',[instant]);
      assert.equal(result.rowCount,1);
    },
    restore,
  };
}
