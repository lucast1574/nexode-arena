import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as THREE from 'three';
import WebSocket from 'ws';
import { startServer } from './index.js';

function inbox(ws) {
  const queue = [], waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); }
    else queue.push(m);
  });
  return (type) => {
    const i = queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { type, resolve, timer: setTimeout(() => reject(new Error(`No ${type} message`)), 4000) };
      waiters.push(w);
    });
  };
}

test('public room validates clients, owns damage and respawn, and cleans up disconnects', async () => {
  const app = await startServer({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const sockets = [];
  const connect = async (name) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/arena');
    sockets.push(ws);
    const next = inbox(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', protocol: 1, name }));
    return { ws, next };
  };
  try {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/server/index.js')).status, 404);
    const unnamed = await connect('');
    const [code] = await once(unnamed.ws, 'close');
    assert.equal(code, 1008);
    const a = await connect('Lucas'), b = await connect('Amigo');
    const wa = await a.next('welcome'), wb = await b.next('welcome');
    assert.notEqual(wa.id, wb.id);
    assert.equal(wb.state.players, 2);
    assert.equal(wb.state.entities.filter((e) => e.team === 'B').length, 6);
    const arena = app.arena, p = arena.players.get(wa.id), ally = arena.players.get(wb.id);
    const originalHealth = p.character.health;
    arena.receive(p, { type: 'damage', health: 9999 });
    assert.equal(p.character.health, originalHealth);
    arena.elapsed += 0.1;
    const originalPosition = p.character.position.clone();
    a.ws.send(JSON.stringify({ type: 'move', position: [999, 999, 999], yaw: 0, pitch: 0 }));
    await a.next('correct');
    assert.ok(p.character.position.distanceTo(originalPosition) < 0.01);

    // Real authoritative raycasts: put a bot in a clear lane and shoot through
    // the public protocol. Clients cannot choose a victim or damage amount.
    const bot = arena.director.characters[0];
    for (const c of arena.director.characters) c.alive = false;
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      const start = arena.nav.spawnPoint(arena.rng, new THREE.Vector3(), { minEnemyDist: 0 });
      if (!start) continue;
      for (const [x, z] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const end = start.clone().add(new THREE.Vector3(x, 0, z));
        if (!arena.nav.isWalkableAt(end.x, end.z)) continue;
        end.y = arena.nav.heightAt(end.x, end.z) + 0.05;
        const eye = start.clone().add(new THREE.Vector3(0, 1.62, 0));
        const chest = end.clone().add(new THREE.Vector3(0, 1.1, 0));
        if (arena.bvh.occluded(eye, chest)) continue;
        p.character.spawn(start, 0); p.controller.position.copy(start);
        bot.spawn(end, 0); bot.update(1 / 30, bot);
        target = { eye, chest }; break;
      }
    }
    assert.ok(target, 'a clear lane exists');
    arena.director.update = () => {}; // Stable target; the AI has its own gameplay suite.
    const direction = target.chest.clone().sub(target.eye).normalize();
    for (let shot = 0; shot < 5; shot++) {
      arena.elapsed += 0.1;
      arena.receive(p, { type: 'shot', origin: target.eye.toArray(), direction: direction.toArray(), damage: 9999 });
    }
    assert.equal(bot.alive, false);
    assert.equal(arena.match.players.get(p.id).kills, 1);
    assert.equal(arena.match.players.get(bot.id).deaths, 1);
    assert.ok((await a.next('hit')).damage < 100, 'server ignores injected damage');
    assert.equal((await b.next('kill')).event.killer, 'Lucas');
    ally.character.spawn(bot.position, 0);
    ally.character.update(1 / 30, ally.character);
    ally.protectedUntil = 0;
    arena.combat.fireBullet({ origin: target.eye, direction, owner: p.character, damage: 500 });
    assert.equal(ally.character.health, 100, 'bullets do not damage teammates');
    arena.combat.detonate(ally.character.position, p.character, 'A');
    assert.equal(ally.character.health, 100, 'grenades do not damage teammates');
    // Spawn protection and friendly fire are applied by the server, not the UI.
    ally.protectedUntil = arena.elapsed + 1;
    ally.character.applyDamage(500, { source: bot });
    assert.equal(ally.character.alive, true);
    ally.protectedUntil = 0;
    ally.character.applyDamage(500, { source: bot });
    assert.equal(ally.character.alive, false);
    arena.step(3.1);
    assert.equal(ally.character.alive, true);
    assert.equal(ally.character.health, 100);
    const round = arena.round;
    arena.match.timeLeft = 0.01;
    arena.step(0.02);
    assert.equal(arena.match.ended, true);
    arena.step(8.1);
    assert.equal(arena.round, round + 1);
    assert.equal(arena.director.characters.length, 6);
    for (let i = 0; i < 6; i++) {
      const c = await connect(`Friend-${i}`); await c.next('welcome');
    }
    const overflow = await connect('Overflow');
    assert.equal((await once(overflow.ws, 'close'))[0], 1013);
    assert.equal(arena.players.size, 8);
    const materials = arena.factory.materials.length;
    const closed = once(a.ws, 'close'); a.ws.close(); await closed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(arena.players.size, 7);
    assert.equal(arena.factory.materials.length, materials - 1);
    assert.equal(arena.director.externalTargets.some((c) => c.id === wa.id), false);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});
