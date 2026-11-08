import * as THREE from 'three';
import { Character } from '../game/Character.js';
import { SeededRandom } from '../core/SeededRandom.js';
import { CARBINE } from '../weapons/Weapon.js';
import { OnlinePanel } from '../ui/OnlinePanel.js';

const vec = (a) => new THREE.Vector3().fromArray(a);

export class Multiplayer {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.connecting = false;
    this.remotes = new Map();
    this.panel = new OnlinePanel(game.uiRoot);
    this.ping = null;
    this.lastStateAt = 0;
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.panel.board.hidden = true;
    });
    window.addEventListener('pagehide', () => this.leave());
  }

  join() {
    if (this.active || this.connecting) return;
    const name = this.game.menu.playerName().replace(/[^\p{L}\p{N} _-]/gu, '').trim();
    if (name.length < 2) {
      this.game.menu.setOnlineStatus('Escribe tu nombre (de 2 a 20 caracteres) para entrar.');
      this.game.menu.el.querySelector('#operator-name').focus();
      return;
    }
    this.connecting = true;
    const g = this.game;
    g.menu.setOnlineStatus('Conectando con la sala…');
    const url = new URL('/arena', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.socket = ws;
    const timeout = setTimeout(() => { if (!this.active) ws.close(); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', protocol: 1, name }));
    ws.onmessage = ({ data }) => {
      if (this.socket !== ws) return;
      const m = JSON.parse(data);
      if (m.type === 'welcome') {
        clearTimeout(timeout);
        this.id = m.id;
        this.active = true;
        this.connecting = false;
        g.prepareOnlineMatch();
        this.applyState(m.state);
        const me = m.state.entities.find((c) => c.id === this.id);
        this.spawn({ position: me.position, yaw: me.yaw });
        this.timer = setInterval(() => this.sendMovement(), 50);
        this.pingTimer = setInterval(() => {
          if (performance.now() - this.lastStateAt > 10000) { this.fail('Conexión interrumpida. Vuelve a entrar.'); return; }
          this.send({ type: 'ping', at: Date.now() });
        }, 2000);
        g.hud.announce('Sala pública', 'Tu equipo contra seis bots');
      } else if (m.type === 'state' && this.active) this.applyState(m.state);
      else if (m.type === 'spawn' && this.active) this.spawn(m);
      else if (m.type === 'correct' && this.active) this.correct(m.position);
      else if (m.type === 'pong') this.ping = Math.max(0, Date.now() - m.at);
      else if (m.type === 'ammo' && this.active) {
        g.weapon.ammo = m.ammo; g.weapon.reserve = m.reserve;
      } else if (m.type === 'damage' && this.active) {
        g.hud.flashDamage(Math.min(0.75, m.amount / 55)); g.audio.playHurt();
      } else if (m.type === 'hit' && this.active) {
        g.hud.showHitmarker(m.killed); g.audio.playHitmarker(m.killed);
        g._pendingHits.push({ position: vec(m.position), damage: m.damage, headshot: m.zone === 'head' });
      } else if (m.type === 'kill' && this.active) {
        g.hud.addKill({ ...m.event, involvesPlayer: null });
      } else if (m.type === 'shot' && this.active && m.owner !== this.id) {
        const owner = this.remotes.get(m.owner)?.character;
        const origin = vec(m.origin), direction = vec(m.direction);
        g.combat.fireBullet({ origin, direction, owner, damage: m.damage,
          spec: m.spec, muzzle: origin, firstPerson: false });
        g.combat.spawnMuzzleFlash(origin, direction, false);
        g.audio.playGunshot(origin, { firstPerson: false });
      } else if (m.type === 'grenade' && this.active) {
        g.combat.throwGrenade({ position: vec(m.origin), velocity: vec(m.velocity),
          owner: m.owner === this.id ? g.playerTarget : this.remotes.get(m.owner)?.character, team: 'A' });
      }
    };
    ws.onerror = () => {};
    ws.onclose = (event) => {
      clearTimeout(timeout);
      if (this.socket === ws) this.fail(event.reason || 'No se pudo conectar. Vuelve a entrar o practica sin conexión.');
    };
  }

  send(m) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 64000) {
      this.socket.send(JSON.stringify(m));
    }
  }

  sendMovement() {
    if (!this.active) return;
    const p = this.game.player;
    if (p.alive && this.game.state === 'playing') this.send({ type: 'move',
      position: p.position.toArray(), yaw: p.yaw, pitch: p.pitch, crouch: p.crouched });
  }

  shoot(shot) {
    if (!this.active) return;
    this.sendMovement();
    this.send({ type: 'shot', origin: shot.origin.toArray(), direction: shot.direction.toArray() });
  }

  spawn(m) {
    const g = this.game;
    g.player.spawn(vec(m.position));
    g.player.yaw = m.yaw;
    g.player.pitch = 0;
    g.player.health = 100;
    g.player.alive = true;
    g.weapon.ammo = CARBINE.magSize;
    g.weapon.reserve = CARBINE.reserve;
    g.weapon.reloading = false;
    g.weapon.fireTimer = 0;
    g.weapon.boltLocked = false;
    g.grenades.reset();
    g.hud.hideRespawn(); g.hud.setDeathFade(0);
    g.audio.setMuffle(g.state === 'paused' ? 0.55 : 0);
  }

  correct(position) {
    const p = this.game.player;
    p.controller.position.fromArray(position);
    p._prevPosition.copy(p.position);
    p._renderPosition.copy(p.position);
    p._eyeY = null;
  }

  applyState(state) {
    const g = this.game;
    this.lastStateAt = performance.now();
    this.state = state;
    g.match.timeLeft = state.timeLeft;
    g.match.scores = state.scores;
    g.match.players = new Map(state.roster.map((p) => [p.id, { ...p, isLocal: p.id === this.id }]));
    g.match.running = false;
    if (state.ended && !this.ended) {
      g.hud.announce(state.scores.A >= state.scores.B ? 'Victoria' : 'Fin de ronda', 'Nueva ronda en unos segundos');
    }
    this.ended = state.ended;
    const seen = new Set();
    for (const e of state.entities) {
      if (e.id === this.id) {
        const died = g.player.alive && !e.alive;
        g.player.health = e.health;
        g.player.alive = e.alive;
        if (died) {
          g.respawnTimer = 3;
          g.weapon.setTrigger(false);
          g.hud.showRespawn('el enemigo', 3);
        }
        continue;
      }
      seen.add(e.id);
      let remote = this.remotes.get(e.id);
      if (!remote) {
        const character = new Character({ id: e.id, team: e.team, variant: this.remotes.size % 3,
          factory: g.factory, bvh: g.world.bvh, rng: new SeededRandom(900 + this.remotes.size),
          prevViewProjection: g.graph.prevViewProjection, shadowSystem: g.graph.shadows });
        character.name = e.name;
        character.spawn(vec(e.position), e.yaw);
        g.world.scene.add(character.mesh);
        g.combat.registerCharacter(character);
        remote = { character, target: vec(e.position), state: e };
        if (e.team === 'A') remote.label = this.panel.createLabel(e.name);
        this.remotes.set(e.id, remote);
      }
      const c = remote.character;
      remote.target.fromArray(e.position);
      remote.state = e;
      if (e.alive && !c.alive) c.spawn(remote.target, e.yaw);
      if (!e.alive && c.alive) c.kill({ direction: new THREE.Vector3(0, 0, 1) });
      c.health = e.health;
      c.velocity.fromArray(e.velocity);
    }
    for (const [id, remote] of this.remotes) if (!seen.has(id)) this.removeRemote(id, remote);
    this.panel.update(state, this.id, this.ping);
  }

  render(dt) {
    if (!this.active) return;
    for (const { character: c, target, state, label } of this.remotes.values()) {
      if (c.alive) c.position.lerp(target, 1 - Math.exp(-18 * Math.min(dt, 0.1)));
      c.update(Math.min(dt, 0.05), { yaw: state.yaw, pitch: state.pitch,
        stance: state.crouch ? 'crouch' : 'stand', aiming: true });
      if (label) {
        const head = c.getEyePosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.45, 0));
        const distance = head.distanceTo(this.game.camera.position);
        const projected = head.clone().project(this.game.camera);
        label.hidden = !c.alive || this.game.state !== 'playing' || distance > 90
          || projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1
          || this.game.world.bvh.occluded(this.game.camera.position, head);
        if (!label.hidden) {
          label.style.left = `${(projected.x * 0.5 + 0.5) * 100}%`;
          label.style.top = `${(-projected.y * 0.5 + 0.5) * 100}%`;
        }
      }
    }
  }

  removeRemote(id, remote) {
    this.game.world.scene.remove(remote.character.mesh);
    this.game.combat.unregisterCharacter(remote.character);
    remote.character.dispose(); this.remotes.delete(id);
    remote.label?.remove();
  }

  fail(message) {
    this.leave();
    this.game.quitToMenu();
    this.game.menu.setOnlineStatus(message);
  }

  leave() {
    this.active = false; this.connecting = false;
    clearInterval(this.timer); clearInterval(this.pingTimer);
    const ws = this.socket;
    this.socket = null;
    if (ws) { ws.onclose = null; ws.close(); }
    for (const [id, remote] of this.remotes) this.removeRemote(id, remote);
    this.panel.hide(); this.ping = null; this.ended = false;
    const g = this.game;
    g.combat.authoritativeVisuals = false;
    g.combat.friendlyFire = true;
    g.combat.sendShot = null;
    g.player.authoritativeHealth = false;
    g.player.regenDelay = 5.5;
  }
}
