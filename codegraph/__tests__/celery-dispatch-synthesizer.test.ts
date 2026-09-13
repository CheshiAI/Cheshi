import { getCodeGraphState } from './helpers/internal-state';
/**
 * Celery task-dispatch bridge (Python).
 *
 * Celery decouples a task's call site from its body: a `@shared_task` / `@app.task`
 * decorated `def` is invoked through `task.delay(...)` / `task.apply_async(...)`, a
 * dynamic hop with no static edge. This bridges each `.delay`/`.apply_async` site to
 * the task function, gated on the DECORATOR (read from the source above the `def`) so a
 * `.delay()` on a non-task object resolves to nothing. Covers both decorator dialects
 * (`@shared_task`, `@app.task(...)`), the module-qualified `mod.task.apply_async()` form,
 * and proves the precision gates: a plain function called with `.delay()` and a canvas
 * `group(...).delay()` (no single identifier before `.delay`) both contribute no edge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('celery-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'celery-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bridges .delay()/.apply_async() to decorated tasks, ignoring non-task and canvas dispatch', async () => {
    // Two decorator dialects: bare @shared_task and arg'd @app.task(...).
    fs.writeFileSync(
      path.join(dir, 'tasks.py'),
      `from celery import shared_task
from myapp.celery import app


@shared_task
def send_email(to):
    return to


@app.task(bind=True, max_retries=3)
def crunch(self, n):
    return n * 2
`
    );
    fs.mkdirSync(path.join(dir, 'services'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'services', 'tickets.py'),
      `from celery import shared_task


@shared_task
def invalidate_cache():
    return None
`
    );
    // A plain function — NOT a celery task — that nonetheless has .delay() called on it.
    fs.writeFileSync(
      path.join(dir, 'utils.py'),
      `def process_data(x):
    return x
`
    );
    // Dispatch sites, all inside one enclosing function.
    fs.writeFileSync(
      path.join(dir, 'views.py'),
      `from tasks import send_email, crunch
from services import tickets
from utils import process_data
from celery import group


def handle_request(req):
    send_email.delay(req.addr)                 # → send_email task (cross-file)
    crunch.apply_async(args=[5])               # → crunch task (@app.task dialect)
    tickets.invalidate_cache.apply_async()     # module-qualified → invalidate_cache
    process_data.delay(req.x)                  # NOT a task → no edge
    group([send_email.s(a) for a in req.addrs]).delay()  # canvas → no edge
`
    );

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const db = getCodeGraphState(cg).db.getDb();

    const edges = db
      .prepare(
        `SELECT s.name AS source, t.name AS target, t.file_path AS tf, json_extract(e.metadata,'$.via') AS via
         FROM edges AS e JOIN nodes AS s ON s.id = e.source JOIN nodes AS t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'celery-dispatch'`
      )
      .all();

    const targets = (src: string) => edges.filter((r: any) => r.source === src).map((r: any) => r.target).sort();
    // handle_request dispatches exactly the three real tasks (both dialects + module-qualified).
    expect(targets('handle_request')).toEqual(['crunch', 'invalidate_cache', 'send_email']);
    // The @app.task target resolved to the task def, not anything else.
    const crunchEdge = edges.find((r: any) => r.target === 'crunch');
    expect(crunchEdge.tf).toMatch(/tasks\.py$/);
    // Module-qualified `tickets.invalidate_cache.apply_async()` resolved by the last identifier.
    const cacheEdge = edges.find((r: any) => r.target === 'invalidate_cache');
    expect(cacheEdge.tf).toMatch(/services[\\/]tickets\.py$/);
    expect(cacheEdge.via).toBe('invalidate_cache');
    // PRECISION: a plain function called with .delay() is never targeted (no decorator).
    expect(edges.some((r: any) => r.target === 'process_data')).toBe(false);

    cg.close?.();
  });

  it('produces no edges in a Celery-free project (clean control)', async () => {
    fs.writeFileSync(
      path.join(dir, 'app.py'),
      `def schedule(job):
    job.delay()          # a .delay() that has nothing to do with Celery
    return job


def run():
    schedule(make_job())
`
    );
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const db = getCodeGraphState(cg).db.getDb();
    const count = db
      .prepare(
        `SELECT count(*) AS c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'celery-dispatch'`
      )
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
