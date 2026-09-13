import { getCodeGraphState } from './helpers/internal-state';
/**
 * Sidekiq job-dispatch bridge (Ruby).
 *
 * Sidekiq decouples a job enqueue from the worker's `perform`, linked by the WORKER CLASS
 * NAME: `DestroyUserWorker.perform_async(id)` has no static edge to `DestroyUserWorker#perform`
 * (usually a different file). This bridges each `Worker.perform_async`/`.perform_in`/`.perform_at`
 * site to that worker's instance `perform`, gated on the class including `Sidekiq::Job`/`Worker`.
 * Covers both include aliases, the scheduled forms, namespace disambiguation (two `NotifyWorker`s
 * in different modules resolve to the right one by qualified name), and the precision boundary: a
 * non-worker class with a `perform`, and an ActiveJob `perform_later`, both produce no edge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

describe('sidekiq-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekiq-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges perform_async/_in to #perform, disambiguates namespaces, ignores non-workers and ActiveJob', async () => {
    write('app/workers/destroy_user_worker.rb', `class DestroyUserWorker
  include Sidekiq::Worker
  def perform(user_id)
    User.find(user_id).destroy!
  end
end
`);
    // Modern Sidekiq::Job alias + the scheduled form.
    write('app/workers/send_email_worker.rb', `class SendEmailWorker
  include Sidekiq::Job
  def perform(addr)
  end
end
`);
    // Namespace collision: two NotifyWorkers, same simple name, different modules.
    write('app/workers/comments/notify_worker.rb', `module Comments
  class NotifyWorker
    include Sidekiq::Job
    def perform(id)
    end
  end
end
`);
    write('app/workers/articles/notify_worker.rb', `module Articles
  class NotifyWorker
    include Sidekiq::Job
    def perform(id)
    end
  end
end
`);
    // A non-worker class that happens to have a `perform` method — never a target.
    write('app/services/report.rb', `class Report
  def perform(x)
  end
end
`);
    // An ActiveJob — dispatched via perform_later, a different shape, not matched.
    write('app/jobs/cleanup_job.rb', `class CleanupJob < ApplicationJob
  def perform
  end
end
`);
    write('app/services/user_service.rb', `class UserService
  def deactivate(user)
    DestroyUserWorker.perform_async(user.id)
    SendEmailWorker.perform_in(5, user.email)
    Comments::NotifyWorker.perform_async(1)
    Articles::NotifyWorker.perform_async(2)
    Report.perform_async(3)
    CleanupJob.perform_later
  end
end
`);

    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const db = getCodeGraphState(cg).db.getDb();

    const edges = db
      .prepare(
        `SELECT s.name AS source, t.name AS target, t.file_path AS tf, json_extract(e.metadata,'$.via') AS via
         FROM edges AS e JOIN nodes AS s ON s.id = e.source JOIN nodes AS t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'sidekiq-dispatch'`
      )
      .all();

    // Four enqueues bridge: both aliases, perform_async + perform_in, two namespaced.
    expect(edges.map((r: any) => r.via).sort()).toEqual([
      'Articles::NotifyWorker', 'Comments::NotifyWorker', 'DestroyUserWorker', 'SendEmailWorker',
    ]);
    expect(edges.every((r: any) => r.target === 'perform' && r.source === 'deactivate')).toBe(true);
    // Namespace disambiguation: each NotifyWorker hits its OWN module's file, not the other.
    expect(edges.find((r: any) => r.via === 'Comments::NotifyWorker').tf).toMatch(/comments[\\/]notify_worker\.rb$/);
    expect(edges.find((r: any) => r.via === 'Articles::NotifyWorker').tf).toMatch(/articles[\\/]notify_worker\.rb$/);
    // PRECISION: a non-worker `perform`, and ActiveJob `perform_later`, contribute nothing.
    expect(edges.some((r: any) => r.via === 'Report')).toBe(false);
    expect(edges.some((r: any) => /Cleanup/.test(r.via))).toBe(false);

    cg.close?.();
  });

  it('produces no edges in a Ruby project with no Sidekiq (clean control)', async () => {
    write('lib/calc.rb', `class Calc
  def add(a, b)
    a + b
  end
end
`);
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const db = getCodeGraphState(cg).db.getDb();
    const count = db
      .prepare(`SELECT count(*) AS c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'sidekiq-dispatch'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
