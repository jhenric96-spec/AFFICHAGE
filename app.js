/* AFFICHAGE : contrôle des poses d'affiches sur le terrain.
   Pour chaque emplacement : une photo, le nombre d'affiches collées (saisi par l'afficheur),
   la position GPS et le nom de l'afficheur. Fonctionne sans réseau : les poses sont gardées sur le téléphone
   (IndexedDB) et envoyées à la Google Sheet (serveur/Code.gs) dès que le réseau revient. Aucune dépendance. */
'use strict';

const VERSION_APP = '1.2.0';
const VERSION_SERVEUR_MIN = 1.0;
const ADRESSE_PUBLIQUE = 'https://jhenric96-spec.github.io/AFFICHAGE/';
const ENVOI_AUTO_MS = 2 * 60 * 1000;
const GPS_PRECISION_VISEE_M = 15;
const GPS_PRECISION_MAX_M = 50;

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function h(tag, attrs, ...enfants) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat(Infinity)) if (e != null && e !== false) el.append(e.nodeType ? e : String(e));
  return el;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));
const jourDe = t => { const d = new Date(t); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const heureDe = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

let toastTimer;
function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('visible'), ms);
}

const Reglages = {
  lire() { try { return JSON.parse(localStorage.getItem('aff-reglages')) || {}; } catch (e) { return {}; } },
  ecrire(r) { try { localStorage.setItem('aff-reglages', JSON.stringify(r)); } catch (e) { /* stockage indisponible */ } },
  maj(fn) { const r = this.lire(); fn(r); this.ecrire(r); return r; },
};

function idAppareil() {
  let r = Reglages.lire();
  if (!r.appareil) r = Reglages.maj(x => { x.appareil = 'AFF-' + uuid().slice(0, 6).toUpperCase(); });
  return r.appareil;
}

/* ------------------------------------------------------------------ */
/* Stockage local (IndexedDB)                                          */
/* ------------------------------------------------------------------ */

const DB = (() => {
  let ouverture;
  function ouvrir() {
    if (!ouverture) ouverture = new Promise((res, rej) => {
      const r = indexedDB.open('affichage', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('poses')) db.createObjectStore('poses', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('divers')) db.createObjectStore('divers', { keyPath: 'cle' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return ouverture;
  }
  async function tx(magasin, mode, fn) {
    const db = await ouvrir();
    return new Promise((res, rej) => {
      const t = db.transaction(magasin, mode);
      const req = fn(t.objectStore(magasin));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    mettre: p => tx('poses', 'readwrite', s => s.put(p)),
    lire: id => tx('poses', 'readonly', s => s.get(id)),
    supprimer: id => tx('poses', 'readwrite', s => s.delete(id)),
    tout: () => tx('poses', 'readonly', s => s.getAll()),
    diversLire: cle => tx('divers', 'readonly', s => s.get(cle)).then(x => x && x.valeur),
    diversMettre: (cle, valeur) => tx('divers', 'readwrite', s => s.put({ cle, valeur })),
  };
})();

/* ------------------------------------------------------------------ */
/* Accueil                                                             */
/* ------------------------------------------------------------------ */

const racineApp = document.getElementById('app');
let ecran = 'accueil';
function vider(nom) { ecran = nom; racineApp.replaceChildren(); window.scrollTo(0, 0); }

const afficheursConnus = () => Reglages.lire().afficheurs || [];

async function afficherAccueil() {
  arreterGps();
  E = null;
  const r = Reglages.lire();
  const poses = (await DB.tout()).sort((a, b) => b.cree - a.cree);
  const brouillon = poses.find(p => p.statut === 'brouillon');
  const faites = poses.filter(p => p.statut !== 'brouillon');
  const auj = jourDe(Date.now());
  const duJour = faites.filter(p => jourDe(p.enregistreeLe) === auj);
  const somme = l => l.reduce((s, p) => s + (Number(p.nombre) || 0), 0);
  const attente = faites.filter(p => p.statut === 'a_envoyer');
  vider('accueil');
  racineApp.append(
    h('header', { class: 'barre' },
      h('div', { class: 'barre-titre' }, h('strong', {}, 'AFFICHAGE'), h('small', {}, r.afficheur ? r.afficheur : 'Contrôle des poses')),
      h('button', { class: 'btn-icone', 'aria-label': 'Paramètres', onclick: ouvrirReglages }, '⚙')),
    h('main', { class: 'accueil' },
      !r.url ? h('div', { class: 'bandeau' },
        h('strong', {}, 'Téléphone pas encore connecté'),
        h('p', {}, 'Scannez le QR code donné par votre responsable avec l\'appareil photo du téléphone. Vous pouvez déjà enregistrer des poses : elles partiront à la connexion.'),
        h('button', { class: 'btn', onclick: collerLienConnexion }, '📋 Coller un lien de connexion')) : null,
      h('div', { class: 'carte identite' },
        h('div', {}, h('small', { class: 'discret' }, 'Afficheur'), h('div', { class: 'nom' }, r.afficheur || 'Non choisi')),
        h('button', { class: 'btn', onclick: () => choisirAfficheur() }, r.afficheur ? 'Changer' : 'Choisir mon nom')),
      brouillon ? h('div', { class: 'carte reprise' },
        h('strong', {}, 'Pose non terminée'),
        h('p', { class: 'discret' }, `Commencée à ${heureDe(brouillon.cree)}.`),
        h('div', { class: 'ligne-boutons' },
          h('button', { class: 'btn', onclick: async () => { if (confirm('Supprimer cette pose non terminée ?')) { await DB.supprimer(brouillon.id); afficherAccueil(); } } }, 'Supprimer'),
          h('button', { class: 'btn primaire', onclick: () => afficherPose(brouillon) }, 'Reprendre'))) : null,
      h('button', { class: 'btn grand primaire', onclick: nouvellePose }, h('span', { class: 'icone' }, '📷'), 'Nouvelle pose d\'affiches'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, somme(duJour)), h('span', {}, `affiches aujourd'hui`), h('small', {}, pluriel(duJour.length, 'photo'))),
        h('div', { class: 'stat' }, h('b', {}, somme(faites)), h('span', {}, 'affiches au total'), h('small', {}, pluriel(faites.length, 'photo')))),
      h('div', { class: 'etat-envoi' + (attente.length ? ' attente' : '') },
        attente.length ? [h('span', {}, `⏳ ${pluriel(attente.length, 'pose')} en attente d'envoi`),
          h('button', { class: 'btn petit', onclick: () => synchroniser({ silencieux: false }) }, 'Envoyer')]
          : faites.length ? h('span', {}, '✓ Tout est envoyé') : h('span', {}, 'Aucune pose pour l\'instant'),
        r.envoiEchec && attente.length ? h('small', { class: 'avert' }, r.envoiEchec) : null),
      faites.length ? h('h2', {}, 'Mes dernières poses') : null,
      h('ul', { class: 'liste-poses' }, faites.slice(0, 30).map(lignePose))),
    h('footer', { class: 'pied' }, `Version ${VERSION_APP} · ${idAppareil()}`));
}

function lignePose(p) {
  const lieu = p.lieu ? [p.lieu.quartier, p.lieu.commune].filter(Boolean).join(', ') : '';
  return h('li', {},
    p.miniature ? h('img', { src: p.miniature, alt: '' }) : h('div', { class: 'vignette-vide' }, '📷'),
    h('div', { class: 'infos' },
      h('strong', {}, pluriel(Number(p.nombre) || 0, 'affiche')),
      h('small', {}, `${jourDe(p.enregistreeLe) === jourDe(Date.now()) ? 'Aujourd\'hui' : new Date(p.enregistreeLe).toLocaleDateString('fr-FR')} à ${heureDe(p.enregistreeLe)}${p.afficheur ? ' · ' + p.afficheur : ''}`),
      lieu ? h('small', { class: 'discret' }, lieu) : null),
    h('span', { class: 'statut ' + p.statut, title: p.statut === 'envoyee' ? 'Envoyée' : 'En attente d\'envoi' }, p.statut === 'envoyee' ? '✓' : '⏳'));
}

/* ---------- Choix de l'afficheur ---------- */

function choisirAfficheur(apres) {
  const noms = afficheursConnus();
  const r = Reglages.lire();
  const fermer = () => voile.remove();
  const choisir = nom => {
    Reglages.maj(x => { x.afficheur = nom; });
    fermer();
    if (apres) apres(nom); else if (ecran === 'accueil') afficherAccueil();
  };
  const voile = h('div', { class: 'voile' },
    h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Choix de l\'afficheur' },
      h('h3', {}, 'Qui êtes-vous ?'),
      noms.length ? h('div', { class: 'choix-noms' }, noms.map(n => h('button', { class: 'btn' + (n === r.afficheur ? ' primaire' : ''), onclick: () => choisir(n) }, n)))
        : h('p', { class: 'discret' }, r.url ? 'Liste des afficheurs pas encore reçue : vérifiez le réseau puis réessayez.' : 'Connectez d\'abord le téléphone (QR code du responsable) pour recevoir la liste des afficheurs.'),
      h('div', { class: 'actions-bas' },
        r.url ? h('button', { class: 'btn', onclick: async () => { await actualiserAfficheurs(); fermer(); choisirAfficheur(apres); } }, '⟳ Actualiser la liste') : null,
        h('button', { class: 'btn', onclick: fermer }, 'Fermer'))));
  document.body.append(voile);
}

async function actualiserAfficheurs() {
  const r = Reglages.lire();
  if (!r.url || !navigator.onLine) return false;
  try {
    const rep = await appelServeur(r.url, { action: 'afficheurs', jeton: r.jeton }, 20000);
    if (rep.ok && Array.isArray(rep.afficheurs)) {
      Reglages.maj(x => { x.afficheurs = rep.afficheurs; });
      return true;
    }
  } catch (e) { /* réseau faible : liste précédente gardée */ }
  return false;
}

/* ------------------------------------------------------------------ */
/* Saisie d'une pose                                                   */
/* ------------------------------------------------------------------ */

let E = null;   // pose en cours : { pose, gps }

function nouvellePose() {
  const r = Reglages.lire();
  if (!r.afficheur) return choisirAfficheur(() => nouvellePose());
  const maintenant = Date.now();
  afficherPose({ id: uuid(), cree: maintenant, statut: 'brouillon', afficheur: r.afficheur, nombre: null, gps: null, photo: null });
}

async function afficherPose(pose) {
  // Une pose reprise plus tard ne garde pas son ancienne position : elle est recapturée sur place
  pose.gps = null;
  E = { pose, gps: null };
  vider('pose');
  const entree = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'cache', id: 'entree-photo', onchange: surPhoto });
  racineApp.append(
    h('header', { class: 'barre' },
      h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: quitterPose }, '←'),
      h('div', { class: 'barre-titre' }, h('strong', {}, 'Nouvelle pose'), h('small', {}, pose.afficheur || ''))),
    h('main', { class: 'pose' },
      entree,
      h('section', { class: 'carte', id: 'bloc-photo' }),
      h('section', { class: 'carte', id: 'bloc-nombre' }),
      h('section', { class: 'carte', id: 'bloc-gps' }),
      h('section', { class: 'carte', id: 'bloc-afficheur' },
        h('h3', {}, '4. Afficheur'),
        h('div', { class: 'ligne-afficheur' }, h('strong', { id: 'nom-afficheur' }, pose.afficheur || '—'),
          h('button', { class: 'btn petit', onclick: () => choisirAfficheur(nom => { E.pose.afficheur = nom; document.getElementById('nom-afficheur').textContent = nom; sauverBrouillon(); }) }, 'Changer')),
        h('label', { class: 'champ' }, h('span', { class: 'discret' }, 'Remarque (facultatif)'),
          h('textarea', { id: 'commentaire', rows: 2, placeholder: 'Ex. : affiche collée sur le mur d\'une boutique', oninput: ev => { E.pose.commentaire = ev.target.value; } }, pose.commentaire || '')))),
    h('div', { class: 'barre-bas' }, h('button', { class: 'btn primaire grand', id: 'valider', onclick: validerPose }, 'Valider la pose')));
  majPhoto(); majNombre(); majGps(); majValider();
  capturerGps();
}

async function quitterPose() {
  const p = E && E.pose;
  if (p && p.photo) { await sauverBrouillon(); toast('Pose gardée : vous pourrez la reprendre depuis l\'accueil'); }
  afficherAccueil();
}

async function sauverBrouillon() {
  if (!E || !E.pose.photo) return;
  await DB.mettre(Object.assign({}, E.pose, { gps: null }));
}

/* ---------- 1. Photo ---------- */

function majPhoto() {
  const b = document.getElementById('bloc-photo');
  if (!b) return;
  const p = E.pose;
  b.replaceChildren(...[
    h('h3', {}, '1. Photo des affiches'),
    p.photo ? [h('img', { class: 'apercu', src: p.photo, alt: 'Photo des affiches' }),
      h('button', { class: 'btn', onclick: () => document.getElementById('entree-photo').click() }, '📷 Reprendre la photo')]
      : [h('p', { class: 'discret' }, 'Placez-vous en face, assez loin pour que toutes les affiches collées à cet endroit soient sur la photo.'),
        h('button', { class: 'btn primaire grand', onclick: () => document.getElementById('entree-photo').click() }, h('span', { class: 'icone' }, '📷'), 'Prendre la photo')]].flat());
}

async function surPhoto(ev) {
  const fichier = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!fichier) return;
  try {
    const [photo, miniature] = await Promise.all([compresserImage(fichier, 1280, 0.78), compresserImage(fichier, 240, 0.7)]);
    Object.assign(E.pose, { photo, miniature, photoPriseLe: fichier.lastModified || Date.now(), empreinte: await empreinte(photo), nombre: null });
    majPhoto(); majNombre(); majValider();
    await sauverBrouillon();
  } catch (e) { toast('Photo illisible : reprenez-la'); }
}

function compresserImage(fichier, max, qualite) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL('image/jpeg', qualite));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    img.src = url;
  });
}

// Empreinte de la photo : le serveur repère une même photo envoyée deux fois
async function empreinte(texte) {
  try {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texte));
    return [...new Uint8Array(b)].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

/* ---------- 2. Nombre d'affiches (saisi par l'afficheur) ---------- */

function majNombre() {
  const b = document.getElementById('bloc-nombre');
  if (!b) return;
  const p = E.pose;
  const enfants = [h('h3', {}, '2. Nombre d\'affiches collées')];
  if (!p.photo) { enfants.push(h('p', { class: 'discret' }, 'Prenez d\'abord la photo.')); b.replaceChildren(...enfants); return; }
  // Champ numérique : clavier chiffres sur téléphone ; pas de nouvel affichage à chaque frappe (le clavier reste ouvert)
  const champ = h('input', { id: 'nombre', class: 'champ-nombre', type: 'number', inputmode: 'numeric', pattern: '[0-9]*', min: '1', max: '99', step: '1',
    placeholder: 'Ex. : 3', 'aria-label': 'Nombre d\'affiches collées', value: p.nombre == null ? '' : String(p.nombre),
    oninput: ev => {
      const v = String(ev.target.value).replace(/[^0-9]/g, '').slice(0, 2);
      E.pose.nombre = v === '' ? null : Number(v);
      majValider(); sauverBrouillon();
    } });
  enfants.push(h('label', { class: 'champ' }, h('span', { class: 'discret' }, 'Nombre d\'affiches collées visibles sur la photo'), champ));
  b.replaceChildren(...enfants);
}

/* ---------- 3. Position GPS ---------- */

let gpsSuivi = null, gpsLimite = null;
function arreterGps() {
  if (gpsSuivi != null && navigator.geolocation) navigator.geolocation.clearWatch(gpsSuivi);
  clearTimeout(gpsLimite); gpsSuivi = null;
}

async function capturerGps() {
  arreterGps();
  if (!navigator.geolocation) { E.gps = { erreur: 'GPS indisponible sur ce téléphone' }; majGps(); return; }
  const id = E.pose.id, debut = Date.now();
  // Positions des poses précédentes : le téléphone renvoie parfois sa dernière position connue au lieu de la position actuelle
  const anciennes = new Set((await DB.tout()).filter(p => p.gps && p.id !== id).map(p => `${p.gps.lat.toFixed(6)},${p.gps.lon.toFixed(6)}`));
  if (!E || E.pose.id !== id) return;
  E.gps = { recherche: true, msg: 'Recherche de la position…' };
  majGps(); majValider();
  const fin = msg => {
    arreterGps();
    if (!E || E.pose.id !== id) return;
    if (E.pose.gps) E.gps = null; else E.gps = { erreur: msg || 'Position introuvable : réessayez à découvert' };
    majGps(); majValider();
  };
  gpsSuivi = navigator.geolocation.watchPosition(pos => {
    if (!E || E.pose.id !== id) return;
    const c = pos.coords;
    if ((pos.timestamp && pos.timestamp < debut - 5000) || anciennes.has(`${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`)) {
      E.gps = { recherche: true, msg: 'Recherche de la position actuelle…' }; majGps(); return;
    }
    if (!E.pose.gps || c.accuracy < E.pose.gps.acc) E.pose.gps = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude || 0, t: pos.timestamp || Date.now() };
    E.gps = { recherche: true, msg: `Affinage… ±${Math.round(c.accuracy)} m` };
    majGps(); majValider();
    if (c.accuracy <= GPS_PRECISION_VISEE_M) fin();
  }, err => fin(err.code === 1 ? 'Autorisez l\'accès à la position pour ce site dans le navigateur' : 'Position introuvable : réessayez à découvert'),
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  gpsLimite = setTimeout(() => fin(), 30000);
}

function majGps() {
  const b = document.getElementById('bloc-gps');
  if (!b) return;
  const g = E.pose.gps, etat = E.gps;
  const enfants = [h('h3', {}, '3. Position')];
  if (g) {
    enfants.push(h('p', { class: g.acc <= GPS_PRECISION_MAX_M ? 'ok' : 'avert' },
      g.acc <= GPS_PRECISION_MAX_M ? '✓ Position enregistrée' : '⚠ Position peu précise', ` (±${Math.round(g.acc)} m)`));
    if (g.acc > GPS_PRECISION_MAX_M && !(etat && etat.recherche)) enfants.push(h('small', { class: 'discret' }, 'Éloignez-vous des murs et des toits, puis touchez « Reprendre la position ».'));
  }
  if (etat && etat.recherche) enfants.push(h('p', { class: 'attente' }, h('span', { class: 'roue' }), etat.msg));
  if (etat && etat.erreur) enfants.push(h('p', { class: 'avert' }, '⚠ ' + etat.erreur));
  if (!(etat && etat.recherche)) enfants.push(h('button', { class: 'btn', onclick: () => { E.pose.gps = null; capturerGps(); } }, '📍 Reprendre la position'));
  b.replaceChildren(...enfants);
}

/* ---------- Validation ---------- */

function manque() {
  const p = E.pose;
  if (!p.photo) return 'Prenez la photo';
  if (!(Number(p.nombre) >= 1)) return 'Indiquez le nombre d\'affiches';
  if (!p.gps) return E.gps && E.gps.recherche ? 'Recherche de la position…' : 'Position manquante';
  if (!p.afficheur) return 'Choisissez l\'afficheur';
  return '';
}

function majValider() {
  const b = document.getElementById('valider');
  if (!b || !E) return;
  const m = manque();
  b.disabled = !!m;
  b.textContent = m || `✔ Valider : ${pluriel(Number(E.pose.nombre), 'affiche')}`;
}

async function validerPose() {
  if (!E || manque()) return;
  const p = E.pose;
  if (p.gps.acc > GPS_PRECISION_MAX_M && !confirm(`La position est peu précise (±${Math.round(p.gps.acc)} m). Valider quand même ?`)) return;
  arreterGps();
  const pose = Object.assign({}, p, { statut: 'a_envoyer', enregistreeLe: Date.now(), commentaire: (p.commentaire || '').trim(),
    version: VERSION_APP });
  await DB.mettre(pose);
  Reglages.maj(x => { x.afficheur = pose.afficheur; });
  toast(`Pose enregistrée ✓ ${pluriel(Number(pose.nombre), 'affiche')}`);
  await afficherAccueil();
  synchroniser({ silencieux: true });
}

/* ------------------------------------------------------------------ */
/* Envoi au serveur                                                    */
/* ------------------------------------------------------------------ */

async function appelServeur(url, donnees, delai = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), delai);
  try {
    // text/plain évite la requête préalable CORS, refusée par Google Apps Script.
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(donnees), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const texte = await r.text();
    try { return JSON.parse(texte); } catch (e) { throw new Error('réponse du serveur illisible : vérifiez le déploiement'); }
  } finally { clearTimeout(t); }
}

let envoiEnCours = false;
async function synchroniser({ silencieux = true } = {}) {
  const r = Reglages.lire();
  if (envoiEnCours) return;
  if (!r.url) { if (!silencieux) toast('Téléphone non connecté : scannez le QR code du responsable'); return; }
  if (!navigator.onLine) { if (!silencieux) toast('Pas de réseau : les poses partiront plus tard'); return; }
  envoiEnCours = true;
  let envoyees = 0, echec = '';
  try {
    if (!(r.afficheurs || []).length || !r.afficheursMaj || Date.now() - r.afficheursMaj > 6 * 3600000) {
      if (await actualiserAfficheurs()) Reglages.maj(x => { x.afficheursMaj = Date.now(); });
    }
    const aEnvoyer = (await DB.tout()).filter(p => p.statut === 'a_envoyer').sort((a, b) => a.enregistreeLe - b.enregistreeLe);
    for (const p of aEnvoyer) {
      try {
        const rep = await appelServeur(r.url, { action: 'pose', jeton: r.jeton, appareil: idAppareil(), version: VERSION_APP, pose: {
          id: p.id, afficheur: p.afficheur, nombre: p.nombre, photo: p.photo, photoPriseLe: p.photoPriseLe,
          enregistreeLe: p.enregistreeLe, empreinte: p.empreinte, gps: p.gps, commentaire: p.commentaire } }, 150000);
        if (!rep.ok) { echec = rep.erreur || 'refusée par le serveur'; continue; }
        // Envoyée : la photo complète est retirée du téléphone (la miniature reste pour la liste)
        const maj = Object.assign({}, p, { statut: 'envoyee', envoyeeLe: Date.now(), photo: null,
          lieu: rep.doublon ? p.lieu : { departement: rep.departement, commune: rep.commune, quartier: rep.quartier, adresse: rep.adresse } });
        await DB.mettre(maj);
        envoyees++;
      } catch (e) { echec = e.name === 'AbortError' ? 'réseau trop lent' : (e.message || 'pas de réseau'); break; }
    }
  } finally {
    envoiEnCours = false;
    Reglages.maj(x => { x.envoiEchec = echec ? `Dernier essai : ${echec}` : ''; x.dernierEnvoi = Date.now(); });
  }
  if (!silencieux) toast(echec ? `Envoi interrompu (${echec})${envoyees ? ` après ${pluriel(envoyees, 'pose')}` : ''}` : envoyees ? `${pluriel(envoyees, 'pose')} envoyée(s) ✓` : 'Rien à envoyer');
  else if (envoyees) toast(`${pluriel(envoyees, 'pose')} envoyée(s) ✓`);
  if (ecran === 'accueil') afficherAccueil();
}

/* ------------------------------------------------------------------ */
/* Paramètres (verrouillés) et connexion des téléphones                */
/* ------------------------------------------------------------------ */

// Code réservé au responsable : seule son empreinte PBKDF2-SHA256 figure ici, le code n'est stocké nulle part en clair
const VERROU = { sel: '232e4e7cbdda44c040da061c2ce86655', iterations: 150000, empreinte: 'ad935e8fe0c9dd7c005545b1105a8b8c908d7832085e252e393940d276fd21dd' };
const DUREE_DEVERROUILLAGE = 60 * 1000;
let deverrouilleJusqua = 0, essaisRates = 0, bloqueJusqua = 0;

async function empreinteCode(code) {
  const octets = new Uint8Array(VERROU.sel.match(/../g).map(x => parseInt(x, 16)));
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: octets, iterations: VERROU.iterations }, cle, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function ouvrirReglages() {
  if (Date.now() < deverrouilleJusqua) return afficherReglages();
  if (!(window.crypto && crypto.subtle)) return toast('Paramètres indisponibles : ouvrez l\'application par son adresse https', 6000);
  const champ = h('input', { type: 'password', inputmode: 'text', autocomplete: 'off', placeholder: 'Code des paramètres', 'aria-label': 'Code des paramètres' });
  const erreur = h('small', { class: 'avert', hidden: true });
  const voir = h('button', { type: 'button', class: 'btn petit', onclick: () => { champ.type = champ.type === 'password' ? 'text' : 'password'; champ.focus(); } }, '👁');
  const valider = async () => {
    if (Date.now() < bloqueJusqua) { erreur.hidden = false; erreur.textContent = `Trop d'essais : réessayez dans ${Math.ceil((bloqueJusqua - Date.now()) / 1000)} s.`; return; }
    if ((await empreinteCode(champ.value)) === VERROU.empreinte) {
      essaisRates = 0; deverrouilleJusqua = Date.now() + DUREE_DEVERROUILLAGE; voile.remove(); afficherReglages(); return;
    }
    essaisRates++;
    if (essaisRates >= 5) { bloqueJusqua = Date.now() + 60000; essaisRates = 0; }
    erreur.hidden = false;
    erreur.textContent = Date.now() < bloqueJusqua ? 'Code incorrect. Trop d\'essais : patientez 1 minute.' : 'Code incorrect.';
    champ.value = ''; champ.focus();
  };
  champ.addEventListener('keydown', ev => { if (ev.key === 'Enter') valider(); });
  const voile = h('div', { class: 'voile centre' },
    h('div', { class: 'feuille', role: 'dialog', 'aria-label': 'Paramètres verrouillés' },
      h('h3', {}, '🔒 Paramètres réservés au responsable'),
      h('div', { class: 'mot-de-passe' }, champ, voir), erreur,
      h('div', { class: 'actions-bas' },
        h('button', { class: 'btn', onclick: () => voile.remove() }, 'Annuler'),
        h('button', { class: 'btn primaire', onclick: valider }, 'Déverrouiller'))));
  document.body.append(voile);
  setTimeout(() => champ.focus(), 50);
}

function afficherReglages() {
  const r = Reglages.lire();
  vider('reglages');
  const diag = h('div', { class: 'diagnostic', hidden: true });
  const champ = (id, lib, val, aide) => h('label', { class: 'champ' }, h('span', { class: 'champ-lib' }, lib),
    h('input', { id, type: 'text', value: val || '', autocomplete: 'off', spellcheck: 'false' }), aide ? h('small', { class: 'discret' }, aide) : null);
  racineApp.append(
    h('header', { class: 'barre' },
      h('button', { class: 'btn-icone', 'aria-label': 'Retour', onclick: afficherAccueil }, '←'),
      h('div', { class: 'barre-titre' }, h('strong', {}, 'Paramètres')),
      h('button', { class: 'btn-icone', 'aria-label': 'Verrouiller', onclick: () => { deverrouilleJusqua = 0; afficherAccueil(); } }, '🔒')),
    h('main', { class: 'reglages' },
      h('section', { class: 'carte' },
        h('h3', {}, 'Serveur'),
        champ('url', 'Adresse du serveur (Apps Script, se termine par /exec)', r.url),
        champ('jeton', 'Clé d\'accès', r.jeton, 'Même valeur que JETON dans serveur/Secret.gs'),
        h('div', { class: 'ligne-boutons' },
          h('button', { class: 'btn primaire', onclick: async () => {
            const url = document.getElementById('url').value.trim(), jeton = document.getElementById('jeton').value.trim();
            Reglages.maj(x => { x.url = url; x.jeton = jeton; });
            await sauvegarderConnexion();
            testerServeur(diag);
          } }, 'Enregistrer et tester')),
        diag),
      r.url && r.jeton ? blocQr(r) : null,
      h('section', { class: 'carte' },
        h('h3', {}, 'Afficheurs'),
        h('p', { class: 'discret' }, afficheursConnus().length ? afficheursConnus().join(' · ') : 'Liste non reçue.'),
        h('p', { class: 'discret' }, 'La liste se modifie dans l\'onglet « Afficheurs » de la Google Sheet.'),
        h('button', { class: 'btn', onclick: async () => { toast(await actualiserAfficheurs() ? 'Liste des afficheurs à jour ✓' : 'Liste non reçue : vérifiez le réseau et la connexion'); afficherReglages(); } }, '⟳ Actualiser la liste')),
      h('section', { class: 'carte' },
        h('h3', {}, 'Ce téléphone'),
        h('p', { class: 'discret' }, `Appareil ${idAppareil()} · version ${VERSION_APP}`),
        h('button', { class: 'btn', onclick: async () => {
          const l = (await DB.tout()).filter(p => p.statut === 'envoyee');
          if (!l.length) return toast('Aucune pose envoyée à retirer');
          if (!confirm(`Retirer de la liste les ${l.length} pose(s) déjà envoyée(s) ? Elles restent dans la Google Sheet.`)) return;
          for (const p of l) await DB.supprimer(p.id);
          toast('Liste vidée ✓');
        } }, 'Vider la liste des poses envoyées'))));
}

async function testerServeur(diag) {
  const r = Reglages.lire();
  diag.hidden = false; diag.className = 'diagnostic'; diag.textContent = 'Test en cours…';
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(r.url || '')) { diag.className = 'diagnostic avert'; diag.textContent = 'Adresse invalide : elle doit commencer par https://script.google.com/macros/s/ et finir par /exec.'; return; }
  try {
    const rep = await appelServeur(r.url, { action: 'ping', jeton: r.jeton }, 30000);
    if (!rep.ok) throw new Error(rep.erreur || 'refus du serveur');
    if (!(Number(rep.version) >= VERSION_SERVEUR_MIN)) throw new Error(`serveur trop ancien (${rep.version || '?'}) : redéployez serveur/Code.gs`);
    Reglages.maj(x => { x.afficheurs = rep.afficheurs || []; x.afficheursMaj = Date.now(); });
    diag.className = 'diagnostic ok';
    diag.textContent = `✓ Connexion réussie (serveur ${rep.version}). ${pluriel((rep.afficheurs || []).length, 'afficheur')}.`;
  } catch (e) { diag.className = 'diagnostic avert'; diag.textContent = '✗ ' + (e.name === 'AbortError' ? 'pas de réponse (réseau ?)' : e.message); }
}

// Les informations de connexion sont placées après « # » : cette partie du lien n'est jamais envoyée au site.
function lienConnexion(url, jeton) {
  const local = location.protocol !== 'https:' || /^(localhost|127\.)/.test(location.hostname);
  const base = local ? ADRESSE_PUBLIQUE : location.origin + location.pathname.replace(/index\.html$/, '');
  const charge = btoa(unescape(encodeURIComponent(JSON.stringify({ u: url, k: jeton })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}#connexion=${charge}`;
}

function lireLienConnexion(hash) {
  const m = String(hash || '').match(/connexion=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
    return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(j.u) && j.k ? { url: j.u, jeton: j.k } : null;
  } catch (e) { return null; }
}

function canevasQr(texte, legende) {
  const qr = qrcode(0, 'M');
  qr.addData(texte); qr.make();
  const n = qr.getModuleCount(), marge = 4, px = 8, haut = 70, bas = 60;
  const cote = (n + 2 * marge) * px;
  const cv = document.createElement('canvas');
  cv.width = cote; cv.height = cote + haut + bas;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#1f3b4d'; g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('AFFICHAGE', cote / 2, 45);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) g.fillRect((x + marge) * px, haut + (y + marge) * px, px, px);
  g.fillStyle = '#333'; g.font = '20px system-ui, sans-serif';
  g.fillText(legende, cote / 2, haut + cote + 35);
  return cv;
}

function blocQr(r) {
  const lien = lienConnexion(r.url, r.jeton);
  const cv = canevasQr(lien, 'Scanner avec l\'appareil photo');
  cv.className = 'qr';
  return h('section', { class: 'carte' },
    h('h3', {}, 'Connecter le téléphone d\'un afficheur'),
    h('p', { class: 'discret' }, 'Sur le téléphone de l\'afficheur, ouvrez l\'appareil photo et visez ce QR code, puis touchez le lien. Le QR code contient la clé d\'accès : ne le publiez pas.'),
    cv,
    h('div', { class: 'ligne-boutons' },
      h('button', { class: 'btn', onclick: () => cv.toBlob(async b => {
        const f = new File([b], 'connexion-affichage.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f], title: 'Connexion AFFICHAGE' }); return; } catch (e) { /* partage annulé */ } }
        const a = h('a', { href: URL.createObjectURL(b), download: 'connexion-affichage.png' }); document.body.append(a); a.click(); a.remove();
      }) }, '⬇ Image du QR code'),
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(lien); toast('Lien copié ✓'); } catch (e) { prompt('Lien de connexion :', lien); } } }, '📋 Copier le lien')));
}

async function collerLienConnexion() {
  let texte = '';
  try { texte = await navigator.clipboard.readText(); } catch (e) { /* presse-papiers refusé */ }
  if (!/connexion=/.test(texte)) texte = prompt('Collez ici le lien de connexion reçu de votre responsable :') || '';
  const i = texte.indexOf('#connexion=');
  if (i < 0) { if (texte) toast('Ce n\'est pas un lien de connexion AFFICHAGE', 5000); return; }
  history.replaceState(history.state, '', location.pathname + location.search + texte.slice(i).trim());
  await importerConnexion();
}

// Copie de secours de la connexion dans IndexedDB (si le petit stockage du navigateur a été vidé)
async function sauvegarderConnexion() {
  const r = Reglages.lire();
  if (r.url) { try { await DB.diversMettre('connexion', { url: r.url, jeton: r.jeton, appareil: r.appareil, afficheur: r.afficheur, afficheurs: r.afficheurs }); } catch (e) { /* sans conséquence */ } }
}
async function restaurerConnexion() {
  if (Reglages.lire().url) return sauvegarderConnexion();
  try { const c = await DB.diversLire('connexion'); if (c && c.url) Reglages.maj(x => { Object.assign(x, c); }); } catch (e) { /* rien à restaurer */ }
}

async function importerConnexion() {
  if (!/connexion=/.test(location.hash)) return;
  const cfg = lireLienConnexion(location.hash);
  history.replaceState(history.state, '', location.pathname + location.search);   // retire la clé de la barre d'adresse
  if (!cfg) { toast('Lien de connexion invalide : demandez un nouveau QR code', 6000); return; }
  const r = Reglages.lire();
  if (r.url && (r.url !== cfg.url || r.jeton !== cfg.jeton) && !confirm('Ce téléphone est déjà relié à un autre serveur. Le remplacer ?')) return;
  Reglages.maj(x => { x.url = cfg.url; x.jeton = cfg.jeton; });
  await sauvegarderConnexion();
  toast('Téléphone connecté ✓');
  if (await actualiserAfficheurs()) Reglages.maj(x => { x.afficheursMaj = Date.now(); });
  await sauvegarderConnexion();
  await afficherAccueil();
  choisirAfficheur(() => { sauvegarderConnexion(); afficherAccueil(); });
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

window.addEventListener('online', () => { if (ecran === 'accueil') afficherAccueil(); synchroniser(); });
setInterval(() => synchroniser(), ENVOI_AUTO_MS);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sauverBrouillon();
  else synchroniser();
});
window.addEventListener('hashchange', () => importerConnexion());

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/\/tests\//.test(location.pathname)) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* hors ligne indisponible, l'application reste utilisable */ });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

if (!window.AFFICHAGE_TEST) restaurerConnexion().then(afficherAccueil).then(importerConnexion).then(() => synchroniser());
