import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { MapGenerator } from '../src/world/MapGenerator.js';
import { BVH } from '../src/physics/BVH.js';
import { CharacterController } from '../src/physics/CharacterController.js';
import { RigidWorld } from '../src/physics/RigidWorld.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { Director } from '../src/ai/Director.js';
import { Character } from '../src/game/Character.js';
import { Match } from '../src/game/Match.js';
import { MaterialFactory } from '../src/render/Materials.js';
import { SeededRandom, WORLD_SEED } from '../src/core/SeededRandom.js';
import { CARBINE } from '../src/weapons/Weapon.js';
import { ServerCombat } from './ServerCombat.js';

export const BOT_COUNT = 6;
export const PROTOCOL = 1;
const vector = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const arr = (v) => v.toArray().map((n) => Math.round(n * 1000) / 1000);

export class Arena {
  constructor() {
    this.players = new Map();
    this.elapsed = 0;
    this.round = 0;
    this.restartAt = null;
    const map = new MapGenerator(WORLD_SEED).generate();
    this.bvh = new BVH(map.soup);
    this.nav = new NavGrid(this.bvh, map.bounds, {
      buildings: map.buildings, playBounds: map.playBounds
    }).bake();
    this.rng = new SeededRandom(WORLD_SEED ^ 0x51de);
    this.factory = new MaterialFactory({}, { albedo: null, normal: null, orm: null });
    this.rigid = new RigidWorld(this.bvh, 32);
    this.combat = new ServerCombat({ world: { bvh: this.bvh }, rigidWorld: this.rigid,
      lightUniforms: {}, quality: { particleDensity: 0, decalBudget: 0 }, audio: null });
    this.combat.friendlyFire = false;
    this.director = new Director({ scene: new THREE.Scene(), nav: this.nav,
      bvh: this.bvh, factory: this.factory, rng: this.rng, combat: this.combat,
      prevViewProjection: { value: new THREE.Matrix4() }, audio: null });
    this.director.setSpawnPoints(map.spawns.A, map.spawns.B);
    this.match = new Match({ scoreLimit: 100, timeLimit: 600 });
    this.match.onKill = (event) => this.broadcast({ type: 'kill', event });
    this.match.onEnd = () => { this.restartAt = this.elapsed + 8; };
    this.director.onAgentKilled = (agent, info) => this.recordKill(agent.character, info);
    this.combat.onShot = (s) => this.broadcast({ type: 'shot', owner: s.owner.id,
      origin: arr(s.origin), direction: arr(s.direction), damage: s.damage, spec: s.spec });
    this.combat.onHitConfirm = (hit) => {
      this.players.get(this.combat.shooter?.id)?.send({ type: 'hit',
        damage: hit.damage, zone: hit.zone, killed: hit.killed, position: arr(hit.position) });
    };
    this.combat.onExplosion = (position) => this.broadcast({ type: 'explosion', position: arr(position) });
    this.resetRound();
  }

  broadcast(message) { for (const p of this.players.values()) p.send(message); }

  resetRound() {
    this.round++;
    this.restartAt = null;
    this.director.dispose();
    this.combat.clear();
    this.match.reset();
    this.director.spawnTeam('B', BOT_COUNT, [0.38, 0.65]);
    for (const c of this.director.characters) {
      c.name = `BOT ${Match.callsign('B', c.id)}`;
      this.match.registerPlayer(c.id, { name: c.name, team: 'B' });
    }
    for (const p of this.players.values()) {
      this.match.registerPlayer(p.id, { name: p.character.name, team: 'A' });
      this.spawn(p);
    }
    this.match.start();
  }

  join(name, send) {
    const id = `p-${randomUUID()}`;
    // Names reach existing scoreboard/killfeed templates: allow text characters only.
    const clean = String(name ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 20);
    if (clean.length < 2) return null;
    const c = new Character({ id, team: 'A', variant: this.players.size % 3,
      factory: this.factory, bvh: this.bvh, rng: this.rng,
      prevViewProjection: { value: new THREE.Matrix4() } });
    c.name = clean;
    const p = { id, character: c, send, lastMove: this.elapsed, lastShot: -99,
      ammo: CARBINE.magSize, reserve: CARBINE.reserve, reloadAt: null,
      grenades: 3, respawnAt: null, protectedUntil: 0, lastDamage: -99,
      controller: new CharacterController(this.bvh, {
        radius: 0.33, height: 1.76, crouchHeight: 0.95, stepOffset: 0.44, slopeLimit: 50
      }) };
    const damage = c.applyDamage.bind(c);
    c.applyDamage = (amount, info) => {
      if (this.elapsed < p.protectedUntil || this.match.ended || !c.alive) return false;
      p.lastDamage = this.elapsed;
      return damage(amount, info);
    };
    c.onDamaged = (amount) => send({ type: 'damage', amount });
    c.onKilled = (info) => {
      p.respawnAt = this.elapsed + 3;
      this.recordKill(c, info);
    };
    this.players.set(id, p);
    this.combat.registerCharacter(c);
    this.director.externalTargets.push(c);
    this.match.registerPlayer(id, { name: c.name, team: 'A' });
    this.spawn(p);
    send({ type: 'welcome', id, protocol: PROTOCOL, state: this.snapshot() });
    return p;
  }

  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.combat.unregisterCharacter(p.character);
    this.director.externalTargets = this.director.externalTargets.filter((c) => c !== p.character);
    for (const a of this.director.agents) if (a.target === p.character) a.target = null;
    p.character.dispose();
    this.players.delete(id);
    this.match.players.delete(id);
  }

  recordKill(victim, info) {
    this.match.registerKill(info?.source?.id ?? null, victim.id, { headshot: info?.zone === 'head' });
  }

  spawn(p) {
    const avoid = [...this.players.values()].filter((q) => q !== p && q.character.alive)
      .map((q) => q.character.position);
    const point = this.nav.spawnPoint(this.rng, new THREE.Vector3(), {
      enemies: this.director.characters, avoid, minEnemyDist: 22, samples: 192
    }) ?? this.nav.spawnPoint(this.rng, new THREE.Vector3(), { minEnemyDist: 0, samples: 512 });
    if (!point) throw new Error('No walkable spawn point');
    point.y += 0.05;
    const closest = this.director.characters.filter((c) => c.alive)
      .sort((a, b) => a.position.distanceToSquared(point) - b.position.distanceToSquared(point))[0];
    const yaw = closest ? Math.atan2(-(closest.position.x - point.x), -(closest.position.z - point.z)) : 0;
    p.character.spawn(point, yaw);
    p.controller.position.copy(point);
    p.controller.velocity.set(0, 0, 0);
    p.character.velocity.set(0, 0, 0);
    p.lastMove = this.elapsed;
    p.respawnAt = null;
    p.protectedUntil = this.elapsed + 1.25;
    p.ammo = CARBINE.magSize;
    p.reserve = CARBINE.reserve;
    p.reloadAt = null;
    p.grenades = 3;
    p.character.update(1 / 30, p.character);
    p.send({ type: 'spawn', position: arr(point), yaw: p.character.yaw });
  }

  receive(p, m) {
    if (!m || typeof m !== 'object') return;
    const c = p.character;
    if (m.type === 'ping') { p.send({ type: 'pong', at: m.at }); return; }
    if (!c.alive || this.match.ended) return;
    if (m.type === 'move') {
      if (!vector(m.position) || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return;
      const dt = Math.min(0.25, this.elapsed - p.lastMove);
      if (dt < 0.02) return;
      p.lastMove = this.elapsed;
      const target = new THREE.Vector3().fromArray(m.position);
      const delta = target.clone().sub(p.controller.position);
      if (delta.length() > 14 * dt + 0.15 || Math.abs(target.y) > 40) {
        p.send({ type: 'correct', position: arr(p.controller.position) }); return;
      }
      p.controller.setHeight(m.crouch === true ? 0.95 : 1.76);
      p.controller.move(dt, delta);
      c.velocity.subVectors(p.controller.position, c.position).divideScalar(dt);
      c.position.copy(p.controller.position);
      c.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
      c.pitch = THREE.MathUtils.clamp(m.pitch, -1.55, 1.55);
      c.stance = m.crouch === true ? 'crouch' : 'stand';
      if (target.distanceTo(c.position) > 0.4) p.send({ type: 'correct', position: arr(c.position) });
    } else if (m.type === 'reload') {
      if (p.reloadAt === null && p.ammo < CARBINE.magSize && p.reserve > 0) {
        p.reloadAt = this.elapsed + (p.ammo === 0 ? CARBINE.reloadEmpty : CARBINE.reloadTactical);
      }
    } else if (m.type === 'shot') {
      if (!vector(m.origin) || !vector(m.direction) || p.reloadAt !== null || p.ammo <= 0) return;
      if (this.elapsed - p.lastShot < 60 / CARBINE.rpm * 0.85) return;
      const origin = new THREE.Vector3().fromArray(m.origin);
      const direction = new THREE.Vector3().fromArray(m.direction);
      if (direction.length() < 0.9 || direction.length() > 1.1) return;
      const eye = c.position.clone().add(new THREE.Vector3(0, c.stance === 'crouch' ? 0.86 : 1.62, 0));
      if (origin.distanceTo(eye) > 0.75 || this.bvh.occluded(eye, origin)) return;
      p.lastShot = this.elapsed;
      p.ammo--;
      this.combat.fireBullet({ origin, direction: direction.normalize(), owner: c,
        damage: CARBINE.damage, spec: CARBINE, firstPerson: true });
      this.director.playerFired(origin);
    } else if (m.type === 'grenade') {
      if (!vector(m.origin) || !vector(m.velocity) || p.grenades <= 0) return;
      const position = new THREE.Vector3().fromArray(m.origin);
      const velocity = new THREE.Vector3().fromArray(m.velocity);
      const eye = c.position.clone().add(new THREE.Vector3(0, 1.2, 0));
      if (position.distanceTo(eye) > 1.2 || velocity.length() > 28 || this.bvh.occluded(eye, position)) return;
      p.grenades--;
      this.combat.throwGrenade({ position, velocity, owner: c, team: 'A' });
      this.broadcast({ type: 'grenade', owner: p.id, origin: arr(position), velocity: arr(velocity) });
    }
  }

  step(dt) {
    // An empty room consumes no simulation CPU. The first visitor starts the clock.
    if (!this.players.size) return;
    this.elapsed += dt;
    if (this.restartAt !== null && this.elapsed >= this.restartAt) this.resetRound();
    this.match.update(dt);
    for (const p of this.players.values()) {
      if (p.respawnAt !== null && this.elapsed >= p.respawnAt && !this.match.ended) this.spawn(p);
      if (p.reloadAt !== null && this.elapsed >= p.reloadAt) {
        const take = Math.min(CARBINE.magSize - p.ammo, p.reserve);
        p.ammo += take; p.reserve -= take; p.reloadAt = null;
        p.send({ type: 'ammo', ammo: p.ammo, reserve: p.reserve });
      }
      if (p.character.alive && this.elapsed - p.lastDamage > 5.5) {
        p.character.health = Math.min(100, p.character.health + dt * 14);
      }
      if (this.elapsed - p.lastMove > 0.15) p.character.velocity.set(0, 0, 0);
      p.character.update(dt, p.character);
    }
    if (!this.match.ended) this.director.update(dt);
    this.rigid.step(dt);
    this.combat.update(dt, this.elapsed);
  }

  snapshot() {
    const entities = [...this.director.characters, ...[...this.players.values()].map((p) => p.character)];
    return { round: this.round, timeLeft: this.match.timeLeft, scores: this.match.scores,
      ended: this.match.ended, players: this.players.size, maxPlayers: null,
      bots: BOT_COUNT, roster: [...this.match.players.values()],
      entities: entities.map((c) => ({ id: c.id, name: c.name, team: c.team,
        position: arr(c.position), velocity: arr(c.velocity), yaw: c.yaw, pitch: c.pitch,
        crouch: c.stance === 'crouch', health: Math.max(0, c.health), alive: c.alive })) };
  }
}
