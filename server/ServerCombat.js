import { Combat } from '../src/combat/Combat.js';

// Keep the same ballistics, hitboxes, penetration and grenade simulation as the
// browser. The server never needs to allocate transient bullet visual effects.
export class ServerCombat extends Combat {
  _surfaceImpact() {}
  _exitSpall() {}
  _ricochetSparks() {}
  _bloodImpact() {}
  _spawnTracer() {}
  spawnMuzzleFlash() {}
  ejectCasing() {}

  fireBullet(shot) {
    this.shooter = shot.owner;
    this.onShot?.(shot);
    return super.fireBullet(shot);
  }
}
