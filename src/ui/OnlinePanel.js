export class OnlinePanel {
  constructor(root) {
    this.status = document.createElement('div');
    this.status.id = 'online-hud';
    this.status.hidden = true;
    root.append(this.status);
    this.board = document.createElement('section');
    this.board.id = 'online-roster';
    this.board.setAttribute('aria-label', 'Marcador de la sala');
    this.board.hidden = true;
    root.append(this.board);
  }

  update(state, id, ping) {
    this.status.hidden = false;
    this.status.textContent = `SALA PÚBLICA · ${state.players} jugadores · ${state.bots} bots`
      + (ping === null ? '' : ` · ${ping} ms`);
    const title = document.createElement('h2');
    title.textContent = 'Suq Al-Rimal';
    const sub = document.createElement('p');
    sub.textContent = 'Cooperativo · jugadores contra bots · bajas / muertes';
    const list = document.createElement('ol');
    for (const p of [...state.roster].sort((a, b) => a.team.localeCompare(b.team) || b.kills - a.kills)) {
      const row = document.createElement('li');
      row.className = p.id === id ? 'local' : '';
      const name = document.createElement('span');
      name.textContent = `${p.name}${p.id === id ? ' (tú)' : ''}`;
      const score = document.createElement('span');
      score.textContent = `${p.kills} / ${p.deaths}`;
      row.append(name, score); list.append(row);
    }
    this.board.replaceChildren(title, sub, list);
  }

  hide() { this.status.hidden = true; this.board.hidden = true; }

  createLabel(name) {
    const label = document.createElement('span');
    label.className = 'operator-label';
    label.textContent = name;
    label.hidden = true;
    this.status.parentElement.append(label);
    return label;
  }
}
