import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';

const DAY_NAMES = ['SAMEDI', 'DIMANCHE'];
const CATEGORY_ORDER = [
  'BABY',
  'MINI HAND',
  'MOINS DE 7',
  'MOINS DE 9',
  'MOINS DE 11',
  'MOINS DE 13',
  'MOINS DE 15',
  'MOINS DE 17',
  'MOINS DE 18',
  'SENIORS',
  'LOISIRS'
];

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isTimeLike(value) {
  if (value == null || value === '') return false;
  if (typeof value === 'number') return value >= 0 && value < 1;
  const text = normalize(value);
  return /^(\d{1,2})[:H](\d{2})$/.test(text);
}

function excelTimeToHHMM(value) {
  if (typeof value === 'number') {
    const totalMinutes = Math.round(value * 24 * 60);
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const text = normalize(value).replace('H', ':');
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return cleanText(value);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function getGenderRank(label) {
  const text = normalize(label);
  if (/\bM\b|MASC|GARCONS|GARS/.test(text)) return 0;
  if (/\bF\b|FEM|FILLES/.test(text)) return 1;
  return 2;
}

function getCategoryRank(label) {
  const text = normalize(label);
  const index = CATEGORY_ORDER.findIndex((cat) => text.includes(cat));
  return index === -1 ? 999 : index;
}

function compareHome(a, b) {
  if (a.day !== b.day) return a.day.localeCompare(b.day);
  return (
    a.time.localeCompare(b.time) ||
    getGenderRank(a.team) - getGenderRank(b.team) ||
    getCategoryRank(a.team) - getCategoryRank(b.team) ||
    a.team.localeCompare(b.team)
  );
}

function compareAway(a, b) {
  if (a.day !== b.day) return a.day.localeCompare(b.day);
  return (
    getCategoryRank(a.team) - getCategoryRank(b.team) ||
    getGenderRank(a.team) - getGenderRank(b.team) ||
    a.team.localeCompare(b.team) ||
    a.time.localeCompare(b.time)
  );
}

function parseStructuredRows(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => normalize(h));
  const indexOf = (...names) => headers.findIndex((h) => names.some((n) => h.includes(n)));

  const dayIdx = indexOf('JOUR');
  const timeIdx = indexOf('HEURE');
  const teamIdx = indexOf('EQUIPE', 'CATEGORIE');
  const opponentIdx = indexOf('ADVERSAIRE', 'ADVERSE', 'OPPOSANT');
  const venueIdx = indexOf('DOMICILE', 'EXTERIEUR', 'TYPE');
  const locationIdx = headers.findIndex((h, i) => i !== venueIdx && (h.includes('LIEU') || h.includes('SALLE') || h.includes('ADRESSE')));

  if (dayIdx === -1 || timeIdx === -1 || teamIdx === -1 || venueIdx === -1) return [];

  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cleanText(cell) !== ''))
    .map((row) => {
      const venueRaw = normalize(row[venueIdx]);
      return {
        day: normalize(row[dayIdx]),
        time: excelTimeToHHMM(row[timeIdx]),
        team: cleanText(row[teamIdx]),
        opponent: opponentIdx >= 0 ? cleanText(row[opponentIdx]) : '',
        locationType: venueRaw.includes('DOM') ? 'domicile' : venueRaw.includes('EXT') ? 'exterieur' : cleanText(row[venueIdx]).toLowerCase(),
        place: locationIdx >= 0 ? cleanText(row[locationIdx]) : ''
      };
    })
    .filter((m) => DAY_NAMES.some((d) => m.day.includes(d)) && m.team && m.time);
}

function parseVisualRows(rows) {
  const matches = [];
  let currentDay = '';
  let currentVenue = '';

  for (const row of rows) {
    const rawCells = row.map((cell) => (cell == null ? '' : cell));
    const joined = normalize(rawCells.map(cleanText).filter(Boolean).join(' '));
    if (!joined) continue;

    if (joined.includes('SAMEDI')) currentDay = 'SAMEDI';
    if (joined.includes('DIMANCHE')) currentDay = 'DIMANCHE';
    if (joined.includes('MATCHS A DOMICILE')) currentVenue = 'domicile';
    if (joined.includes('MATCHS A L EXTERIEUR')) currentVenue = 'exterieur';
    if (!currentDay || !currentVenue) continue;

    const timeIndex = rawCells.findIndex((cell) => isTimeLike(cell));
    if (timeIndex === -1) continue;
    const time = excelTimeToHHMM(rawCells[timeIndex]);

    const textCells = rawCells
      .map((cell, index) => ({ index, value: cleanText(cell) }))
      .filter((cell) => cell.value !== '');

    const teamCell = textCells.find(
      (cell) => cell.index > timeIndex && !/^A\s/.test(normalize(cell.value)) && !normalize(cell.value).includes('PNS')
    );
    const placeCell = textCells.find(
      (cell) => cell.index > timeIndex && (/^A\s|^À\s/.test(normalize(cell.value)) || cell.index >= 7)
    );

    if (teamCell?.value) {
      matches.push({
        day: currentDay,
        time,
        team: teamCell.value,
        opponent: '',
        locationType: currentVenue,
        place: placeCell?.value || ''
      });
    }
  }

  return matches;
}

function deduplicate(matches) {
  const seen = new Set();
  return matches.filter((m) => {
    const key = `${m.day}|${m.time}|${normalize(m.team)}|${normalize(m.opponent || '')}|${m.locationType}|${normalize(m.place)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const rows = workbook.SheetNames.flatMap((name) =>
          XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' })
        );
        const structured = parseStructuredRows(rows);
        resolve(deduplicate(structured.length ? structured : parseVisualRows(rows)));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function groupByDay(matches) {
  return DAY_NAMES.map((day) => ({
    day,
    items: matches.filter((m) => m.day.includes(day))
  })).filter((g) => g.items.length > 0);
}

function downloadTemplate() {
  const rows = [
    ['Jour', 'Heure', 'Équipe', 'Adversaire', 'Domicile/Extérieur', 'Lieu'],
    ['Samedi', '13:30', 'Moins de 15 M 1', 'Ossau', 'Domicile', ''],
    ['Samedi', '18:00', 'Moins de 18 F 1', 'Nafarroa', 'Domicile', 'À Buros'],
    ['Dimanche', '16:00', 'Seniors M 1', 'Hendaye', 'Extérieur', '']
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 24 }, { wch: 22 }, { wch: 20 }, { wch: 18 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Matchs');

  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'modele_planning_matchs.xlsx';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function PreviewRow({ match, away }) {
  return (
    <div className={`preview-row ${away ? 'away' : 'home'}`}>
      <div className="preview-team">{match.team}</div>
      <div className="preview-vs">VS</div>
      <div className="preview-opponent">{match.opponent || match.place || (away ? 'EXTÉRIEUR' : 'DOMICILE')}</div>
      <div className="preview-time">{match.time}</div>
    </div>
  );
}

export default function App() {
  const [background, setBackground] = useState('');
  const [backgroundName, setBackgroundName] = useState('');
  const [matches, setMatches] = useState([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [previewTitle, setPreviewTitle] = useState('PLANNING DU WEEK-END');
  const [previewSubtitle, setPreviewSubtitle] = useState('APERÇU EN DIRECT');
  const [showHome, setShowHome] = useState(true);
  const [showAway, setShowAway] = useState(true);

  useEffect(() => {
    return () => {
      if (background && background.startsWith('blob:')) URL.revokeObjectURL(background);
    };
  }, [background]);

  const homeGroups = useMemo(() => groupByDay(matches.filter((m) => m.locationType === 'domicile').sort(compareHome)), [matches]);
  const awayGroups = useMemo(() => groupByDay(matches.filter((m) => m.locationType === 'exterieur').sort(compareAway)), [matches]);

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const parsed = await readWorkbook(file);
      setMatches(parsed);
      setFileName(file.name);
      if (!parsed.length) setError('Aucun match exploitable trouvé dans ce fichier.');
    } catch {
      setMatches([]);
      setFileName(file.name);
      setError('Le fichier n’a pas pu être lu correctement.');
    }
  }

  function handleBackgroundChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (background && background.startsWith('blob:')) URL.revokeObjectURL(background);
    const url = URL.createObjectURL(file);
    setBackground(url);
    setBackgroundName(file.name);
  }

  function resetAll() {
    if (background && background.startsWith('blob:')) URL.revokeObjectURL(background);
    setBackground('');
    setBackgroundName('');
    setMatches([]);
    setFileName('');
    setError('');
    setPreviewTitle('PLANNING DU WEEK-END');
    setPreviewSubtitle('APERÇU EN DIRECT');
    setShowHome(true);
    setShowAway(true);
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <div className="tag">Planning handball</div>
          <h1>Planning matchs</h1>
          <p>Importe ton Excel, change le fond, trie automatiquement les matchs et vois l’aperçu en direct.</p>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>Import</h2>
          <label className="upload-box">
            <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
            <span>Choisir un fichier Excel</span>
            <small>Compatible avec un modèle simple ou avec un planning visuel proche du fichier club.</small>
          </label>

          <div className="actions">
            <label className="button alt">
              Changer fond
              <input type="file" accept="image/*" onChange={handleBackgroundChange} hidden />
            </label>
            <button type="button" className="button alt" onClick={downloadTemplate}>Télécharger le modèle</button>
            <button type="button" className="button" onClick={() => window.print()} disabled={!matches.length}>Imprimer / PDF</button>
            <button type="button" className="button alt" onClick={resetAll}>Réinitialiser</button>
          </div>

          {fileName ? <div className="info">Fichier chargé : <strong>{fileName}</strong></div> : null}
          {backgroundName ? <div className="info">Fond chargé : <strong>{backgroundName}</strong></div> : null}
          {error ? <div className="error">{error}</div> : null}

          <div className="editor-grid">
            <div>
              <label>Titre</label>
              <input value={previewTitle} onChange={(e) => setPreviewTitle(e.target.value)} />
            </div>
            <div>
              <label>Sous-titre</label>
              <input value={previewSubtitle} onChange={(e) => setPreviewSubtitle(e.target.value)} />
            </div>
          </div>

          <div className="toggles">
            <button type="button" className={`chip ${showHome ? 'active' : ''}`} onClick={() => setShowHome((v) => !v)}>
              {showHome ? 'Domicile affiché' : 'Afficher domicile'}
            </button>
            <button type="button" className={`chip ${showAway ? 'active' : ''}`} onClick={() => setShowAway((v) => !v)}>
              {showAway ? 'Extérieur affiché' : 'Afficher extérieur'}
            </button>
          </div>

          <div className="rules">
            <div><strong>Domicile</strong><span>trié par heure</span></div>
            <div><strong>Extérieur</strong><span>trié par catégorie</span></div>
            <div><strong>Ordre</strong><span>masculin avant féminin</span></div>
          </div>
        </section>

        <section className="preview-shell">
          <div className="preview" style={{ background: background ? `url(${background}) center/cover no-repeat` : 'linear-gradient(135deg,#7f1010,#4b0000)' }}>
            <div className="overlay">
              <div className="preview-header">
                <h2>{previewTitle}</h2>
                <h3>{previewSubtitle}</h3>
              </div>

              {!matches.length && <div className="placeholder">Aperçu ici — importe un Excel ou télécharge le modèle pour commencer.</div>}

              {showHome && homeGroups.map((group) => (
                <div key={`home-${group.day}`} className="group-block">
                  <div className="group-title">{group.day} — Domicile</div>
                  {group.items.map((match, index) => <PreviewRow key={`h-${group.day}-${index}`} match={match} away={false} />)}
                </div>
              ))}

              {showAway && awayGroups.map((group) => (
                <div key={`away-${group.day}`} className="group-block">
                  <div className="group-title">{group.day} — Extérieur</div>
                  {group.items.map((match, index) => <PreviewRow key={`a-${group.day}-${index}`} match={match} away />)}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
