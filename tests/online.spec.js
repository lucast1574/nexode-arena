import { test, expect } from '@playwright/test';

test('a shared auto link still asks a real player for their name', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  await page.goto('/?auto=1&quality=1');
  await page.waitForFunction(() => window.__ready === true);
  await expect(page.locator('#operator-name')).toBeVisible();
  await expect(page.locator('#online-status')).toContainText('sin límite');
  expect(await page.evaluate(() => window.__game.state)).toBe('menu');
});

test('required names, one shared room, shared bots, movement, scoreboard and leaving', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const alice = await context.newPage();
  const bob = await context.newPage();
  const errors = [];
  for (const p of [alice, bob]) p.on('pageerror', (e) => errors.push(e.message));
  try {
    await alice.goto(`${baseURL}/?quality=1`);
    await alice.waitForFunction(() => window.__ready === true);
    await alice.locator('#operator-name').fill('');
    await alice.locator('#mi-primary').click();
    await expect(alice.locator('#online-status')).toContainText('Escribe tu nombre');
    expect(await alice.evaluate(() => window.__game.multiplayer.active)).toBe(false);
    await alice.locator('#operator-name').fill('Lucas');
    await alice.locator('#mi-primary').click();
    await alice.waitForFunction(() => window.__game.multiplayer.active);
    await bob.goto(`${baseURL}/?quality=1`);
    await bob.waitForFunction(() => window.__ready === true);
    await bob.locator('#operator-name').fill('Amigo');
    await bob.locator('#operator-name').press('Enter');
    await bob.waitForFunction(() => window.__game.multiplayer.active);
    await alice.waitForFunction(() => window.__game.multiplayer.state.players === 2);
    const [a, b] = await Promise.all([alice, bob].map((p) => p.evaluate(() => ({
      id: window.__game.multiplayer.id,
      bots: window.__game.multiplayer.state.entities.filter((c) => c.team === 'B').map((c) => c.id),
      round: window.__game.multiplayer.state.round,
      names: window.__game.multiplayer.state.roster.map((p) => p.name)
    }))));
    expect(a.id).not.toBe(b.id);
    expect(a.bots).toHaveLength(6);
    expect(a.bots).toEqual(b.bots);
    expect(a.round).toBe(b.round);
    expect(a.names).toContain('Amigo');
    expect(b.names).toContain('Lucas');
    await expect(alice.locator('.operator-label')).toHaveText('Amigo');
    await alice.bringToFront();
    const before = await alice.evaluate(() => {
      const g = window.__game;
      window.__harness.resume();
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI / 8, p = g.player.position.clone();
        p.x += Math.cos(a) * 3; p.z += Math.sin(a) * 3;
        if (!g.nav.isWalkableAt(p.x, p.z)) continue;
        p.y = g.player.eye.y;
        if (g.world.bvh.occluded(g.player.eye, p)) continue;
        window.__harness.aimAt(p.x, p.y, p.z); break;
      }
      return g.player.position.toArray();
    });
    await alice.evaluate(() => window.__harness.key('KeyW', true));
    await alice.waitForTimeout(600);
    await alice.evaluate(() => window.__harness.key('KeyW', false));
    const position = await alice.evaluate(() => window.__game.player.position.toArray());
    expect(Math.hypot(...position.map((n, i) => n - before[i]))).toBeGreaterThan(0.2);
    await expect.poll(() => bob.evaluate(({ id, position }) => {
      const e = window.__game.multiplayer.state.entities.find((e) => e.id === id);
      return e ? Math.hypot(...e.position.map((n, i) => n - position[i])) : Infinity;
    }, { id: a.id, position })).toBeLessThan(0.6);
    await alice.bringToFront();
    await alice.keyboard.down('Tab');
    await expect(alice.locator('#online-roster')).toBeVisible();
    await expect(alice.locator('#online-roster')).toContainText('Amigo');
    await alice.keyboard.up('Tab');
    await expect(alice.locator('#online-roster')).toBeHidden();
    await alice.evaluate(() => window.__game.quitToMenu());
    await bob.waitForFunction(() => window.__game.multiplayer.state.players === 1);
    expect(await bob.evaluate(() => window.__game.multiplayer.remotes.size)).toBe(6);
    // An interrupted socket leaves a usable menu, never a frozen live match.
    await bob.evaluate(() => window.__game.multiplayer.socket.close());
    await expect(bob.locator('#menu')).toBeVisible();
    await expect(bob.locator('#online-status')).toContainText('conectar');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
