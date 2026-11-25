/* ===== Suivi Ongles – application ===== */
'use strict';

/* Salon de la cliente : donné une fois dans le lien, puis mémorisé sur l'appareil.
   - ?salon=<identifiant du Google Sheet> → serveur central (mises à jour pour toutes les clientes en une fois)
   - ?api=<adresse d'une application déployée> → ancien format, toujours accepté */
const SERVEUR_CENTRAL = 'https://script.google.com/macros/s/AKfycbxWejimyOL5FGpNqy3qYO6JLQZswiVAsl_CDho2ueERr3MP3WwFob3f8E_UDSnLzZQE/exec';
const API_VALIDE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/;
const SALON_VALIDE = /^[\w-]{25,80}$/;
const { API, SALON } = (function () {
  let q = null;
  try { q = new URLSearchParams(location.search); } catch (e) { q = null; }
  const changer = (cle, val) => {
    try {
      const avant = (localStorage.getItem('salon_suivi') || '') + '|' + (localStorage.getItem('api_suivi') || '');
      localStorage.setItem('salon_suivi', cle === 'salon' ? val : '');
      localStorage.setItem('api_suivi', cle === 'api' ? val : '');
      const apres = localStorage.getItem('salon_suivi') + '|' + localStorage.getItem('api_suivi');
      if (avant !== apres) ['pin_suivi', 'donnees_suivi', 'attente_suivi'].forEach(k => localStorage.removeItem(k)); // autre salon
    } catch (e) { /* stockage indisponible */ }
    history.replaceState(null, '', location.pathname);
  };
  const salon = q && q.get('salon'), api = q && q.get('api');
  if (salon && SALON_VALIDE.test(salon)) { changer('salon', salon); return { API: SERVEUR_CENTRAL, SALON: salon }; }
  if (api && API_VALIDE.test(api)) { changer('api', api); return { API: api, SALON: '' }; }
  let s = '', a = '';
  try { s = localStorage.getItem('salon_suivi') || ''; a = localStorage.getItem('api_suivi') || ''; } catch (e) { /* rien */ }
  if (SALON_VALIDE.test(s)) return { API: SERVEUR_CENTRAL, SALON: s };
  if (API_VALIDE.test(a)) return { API: a, SALON: '' };
  return { API: '', SALON: '' };
})();
const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const GENERIQUES = ['cliente', 'client', 'accompagnant', 'accompagnante'];
const ICONES_PAIEMENT = { 'Espèces': '💶', 'Carte': '💳', 'Wero': '📲', 'Chèque': '🧾', 'Virement': '🏦', 'Autre': '📱', 'Non renseigné': '❔' };
const ICONES_CAT = {
  'Produits & consommables': '🛍️', 'Matériel & équipement': '🔌', 'Hygiène & désinfection': '🧴', 'Formation': '🎓',
  'Publicité & communication': '📣', 'Local & loyer': '🏠', 'Déplacements': '🚗', 'Assurance & banque': '🏦',
  'URSSAF & cotisations': '🏛️', 'Autre': '📦',
};

let D = null;            // données du serveur
let PIN = '';
let vueActive = 'nouvelle';

/* ---------- Outils ---------- */
const $ = id => document.getElementById(id);
const euros = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('fr-FR') + ' €';
const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
const nombre = s => Number(String(s).replace(',', '.'));
const pad = n => String(n).padStart(2, '0');
const isoAujourdhui = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* stockage indisponible */ } }

function message(t, ms) {
  const m = $('msg'); m.textContent = t; m.style.display = 'block';
  clearTimeout(m._t); m._t = setTimeout(() => m.style.display = 'none', ms || 3500);
}
function erreur(e) { message('⚠️ ' + (e && e.message ? e.message : e), 6000); }

/** « 9 h 30 », « 9h30 », « 14 h » → « 09:30 » */
function heureVersChamp(h) {
  const m = String(h || '').match(/(\d{1,2})\s*h\s*(\d{2})?/i) || String(h || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? pad(+m[1] % 24) + ':' + pad(m[2] ? +m[2] : 0) : '';
}

/* ---------- Échange avec le Google Sheet ---------- */
async function api(action, extra) {
  let r;
  try {
    r = await fetch(API, { method: 'POST', credentials: 'omit', body: JSON.stringify(Object.assign({ pin: PIN, action }, SALON ? { salon: SALON } : {}, extra || {})) });
  } catch (e) {
    const err = new Error('Pas de connexion internet.'); err.horsLigne = true; throw err;
  }
  let j;
  try { j = await r.json(); } catch (e) { const err = new Error('Réponse illisible, réessaie.'); err.horsLigne = true; throw err; }
  if (!j.ok) throw new Error(j.erreur);
  return j;
}

/* ---------- Saisies en attente (hors connexion) ---------- */
const CLE_ATTENTE = 'attente_suivi', CLE_DONNEES = 'donnees_suivi', CLE_PIN = 'pin_suivi';
let horsLigne = false, envoiEnCours = false;
const fileAttente = () => { try { return JSON.parse(lsGet(CLE_ATTENTE) || '[]'); } catch (e) { return []; } };
const ecrireAttente = l => lsSet(CLE_ATTENTE, JSON.stringify(l));

function mettreEnAttente(item) {
  const l = fileAttente(); l.push(item); ecrireAttente(l); majBandeau();
}

async function envoyerAttente() {
  if (envoiEnCours || !PIN) return;
  let l = fileAttente();
  if (!l.length) { majBandeau(); return; }
  envoiEnCours = true;
  let dernieres = null, envoyees = 0;
  try {
    while (l.length) {
      const item = l[0];
      try {
        const j = await api(item.action, Object.assign({ uid: item.uid }, item.extra));
        dernieres = item.action === 'ajouter' ? (j.resultat.data || j.resultat) : (j.data.data || j.data);
        envoyees++;
      } catch (e) {
        if (e.horsLigne) { horsLigne = true; break; }
        erreur('Saisie en attente refusée (' + (item.resume || '') + ') : ' + e.message);
      }
      l = fileAttente(); l.shift(); ecrireAttente(l);
    }
  } finally {
    envoiEnCours = false;
  }
  if (envoyees) { horsLigne = false; majTout(dernieres); message('📶 ' + envoyees + ' saisie' + (envoyees > 1 ? 's envoyées' : ' envoyée') + ' au Google Sheet.'); }
  majBandeau();
}

function majBandeau() {
  const n = fileAttente().length, b = $('bandeau');
  if (!n && !horsLigne) { b.classList.add('cache'); return; }
  b.classList.remove('cache');
  b.textContent = (horsLigne ? '📴 Pas d\'internet' : '⏳ Envoi en cours') +
    (n ? ' · ' + n + ' saisie' + (n > 1 ? 's' : '') + ' en attente, envoi automatique au retour du réseau' : ' · données du dernier chargement');
}
window.addEventListener('online', () => { horsLigne = false; envoyerAttente(); });
window.addEventListener('offline', () => { horsLigne = true; majBandeau(); });
setInterval(envoyerAttente, 30000);

/* ---------- Code PIN et chargement ---------- */
PIN = lsGet(CLE_PIN) || '';

function demanderPin(msg) {
  $('chargement').classList.add('cache');
  $('v-pin').classList.remove('cache');
  $('pinMsg').textContent = msg || '';
  $('pin').value = ''; $('pin').focus();
}
function validerPin() {
  PIN = $('pin').value.trim();
  $('v-pin').classList.add('cache'); $('chargement').classList.remove('cache');
  charger();
}

function charger() {
  if (!API) {
    $('chargement').textContent = "🔗 Ouvre l'application avec le lien qui t'a été envoyé (il contient l'adresse de ton salon).";
    return;
  }
  if (!PIN) return demanderPin();
  api('donnees').then(j => {
    lsSet(CLE_PIN, PIN);
    horsLigne = false;
    D = j.data; lsSet(CLE_DONNEES, JSON.stringify(D));
    $('chargement').classList.add('cache'); init(); envoyerAttente();
  }).catch(e => {
    if (e.message === 'PIN') { lsDel(CLE_PIN); PIN = ''; return demanderPin('❌ Code incorrect, réessaie.'); }
    if (/essais/.test(e.message)) return demanderPin('⛔ ' + e.message);
    const cache = lsGet(CLE_DONNEES);
    if (e.horsLigne && cache) {
      horsLigne = true; D = JSON.parse(cache);
      $('chargement').classList.add('cache'); init(); majBandeau();
      return;
    }
    $('chargement').textContent = '⚠️ ' + e.message;
  });
}

function afficherEnTete() {
  if (!D || !D.reglages || !D.reglages.nomSalon) return;
  const t = $('titre'); t.textContent = '';
  if (P().logo) { const img = el('img', 'logo'); img.src = P().logo; img.alt = ''; img.onerror = () => img.remove(); t.appendChild(img); }
  t.appendChild(document.createTextNode((P().logo ? '' : icone() + ' ') + D.reglages.nomSalon));
  document.title = D.reglages.nomSalon;
}
function enTeteDepuisCache() {
  try {
    const c = JSON.parse(localStorage.getItem('donnees_suivi') || 'null');
    if (c && c.reglages) { D = c; afficherEnTete(); appliquerTheme(); $('iconeClients').textContent = iconeClients(); D = null; }
  } catch (e) { D = null; }
}

let initFait = false;
function init() {
  afficherEnTete();
  appliquerReglages();
  $('sousTitre').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  document.querySelectorAll('.debutOffre').forEach(s => s.textContent = D.debutOffre);
  if (!initFait) {
    document.querySelectorAll('#filtres .puce').forEach(b => b.onclick = () => {
      filtre = b.dataset.f;
      document.querySelectorAll('#filtres .puce').forEach(x => x.classList.toggle('on', x === b));
      afficherClientes();
    });
    initFait = true;
  }
  construirePrestations();
  construirePaiements($('choixPaiement'), m => { paiementChoisi = m; });
  nouvelleSaisie();
  initAchats();
  rafraichir();
  vue('nouvelle');
}

/** Met à jour toutes les vues avec de nouvelles données. */
function majTout(d) {
  if (!d) return;
  D = d; lsSet(CLE_DONNEES, JSON.stringify(D));
  appliquerReglages();
  construirePrestations(true);
  construireChoixOffres();
  rafraichir();
  if (vueActive === 'fiche' && ficheCle) ouvrirFiche(ficheCle, true);
}
function rafraichir() {
  afficherClientes(); afficherBilan(); afficherTarifs(); afficherOffres(); afficherAchats(); remplirNoms();
}

function vue(v) {
  vueActive = v;
  ['nouvelle', 'clientes', 'fiche', 'tarifs', 'achats', 'bilan'].forEach(x => $('v-' + x).classList.toggle('cache', x !== v));
  ['nouvelle', 'clientes', 'tarifs', 'achats', 'bilan'].forEach(x => $('t-' + x).classList.toggle('actif', x === v || (v === 'fiche' && x === 'clientes')));
  if (v === 'tarifs') afficherTarifs();
  window.scrollTo(0, 0);
}

/* ======================= NOUVELLE PRESTATION ======================= */
let cliente = null, choisis = [], prixManuel = false, offreChoisie = null, paiementChoisi = null;

function maintenant() {
  const d = new Date();
  $('date').value = isoAujourdhui();
  const m = Math.round(d.getMinutes() / 15) * 15;
  const h = m === 60 ? d.getHours() + 1 : d.getHours();
  $('heure').value = pad(h % 24) + ':' + pad(m % 60);
}

function nouvelleSaisie() {
  cliente = null; choisis = []; prixManuel = false; offreChoisie = null; paiementChoisi = null;
  $('recherche').value = ''; $('prix').value = '';
  $('prixAuto').classList.add('cache');
  $('clienteChoisie').classList.add('cache'); $('clienteRecherche').classList.remove('cache');
  $('formulaire').classList.remove('cache'); $('succes').classList.add('cache');
  $('btnEnregistrer').disabled = false; $('btnEnregistrer').textContent = '✔ Enregistrer';
  document.querySelectorAll('#prestations .presta, #options .presta, #choixDeplacement .presta').forEach(b => b.classList.remove('on'));
  document.querySelectorAll('#choixPaiement .puce').forEach(b => b.classList.remove('on'));
  construireChoixOffres();
  maintenant(); filtrerClientes(); majResume();
  window.scrollTo(0, 0);
}

function infoCliente(c) {
  if (!c.total) return M('nouvelle cliente', 'nouveau client');
  const reste = D.passagesPourOffre - (c.depuis % D.passagesPourOffre);
  return c.total + ' passage' + (c.total > 1 ? 's' : '') + (reste === 1 && fideliteActive() ? ' · 🎁 ' + RED() + ' cette fois !' : '');
}

function filtrerClientes() {
  const q = norm($('recherche').value);
  const box = $('suggestions'); box.innerHTML = '';
  if (!q) {
    const recents = [];
    D.journal.slice().reverse().forEach(r => {
      const c = D.clientes.find(x => x.cle === r.cle);
      if (c && !recents.includes(c) && recents.length < 5) recents.push(c);
    });
    if (recents.length) box.appendChild(el('div', 'discret', M('Clientes récentes :', 'Clients récents :')));
    recents.forEach(c => box.appendChild(boutonCliente(c)));
    return;
  }
  const res = D.clientes.filter(c => norm(c.nom).includes(q)).slice(0, 8);
  res.forEach(c => box.appendChild(boutonCliente(c)));
  if (!res.some(c => c.cle === q)) {
    const nom = $('recherche').value.trim();
    const b = el('button', 'choix nouvelle', M('➕ Nouvelle cliente : ', '➕ Nouveau client : ') + nom);
    b.onclick = () => choisirCliente({ nom, cle: q, total: 0, depuis: 0, nouvelle: true });
    box.appendChild(b);
  }
}

function boutonCliente(c) {
  const b = el('button', 'choix');
  b.appendChild(el('span', '', c.nom));
  b.appendChild(el('small', '', infoCliente(c)));
  b.onclick = () => choisirCliente(c);
  return b;
}

function choisirCliente(c) {
  cliente = c;
  $('clienteNom').textContent = c.nom;
  $('clienteChoisie').classList.remove('cache'); $('clienteRecherche').classList.add('cache');
  majResume();
}
function changerCliente() { cliente = null; $('clienteChoisie').classList.add('cache'); $('clienteRecherche').classList.remove('cache'); $('recherche').focus(); majResume(); }

function construirePrestations(garderChoix) {
  const zP = $('prestations'), zO = $('options'); zP.innerHTML = ''; zO.innerHTML = '';
  if (!garderChoix) choisis = [];
  D.tarifs.forEach(t => {
    const b = el('button', 'presta' + (choisis.some(x => x.nom === t.nom) ? ' on' : ''), t.nom);
    b.appendChild(el('b', '', (t.option ? '+ ' : '') + euros(t.prix)));
    b.onclick = () => {
      const i = choisis.findIndex(x => x.nom === t.nom);
      if (i >= 0) { choisis.splice(i, 1); b.classList.remove('on'); } else { choisis.push({ nom: t.nom, prix: t.prix }); b.classList.add('on'); }
      if (!prixManuel) $('prix').value = choisis.length ? sommeChoisis() : '';
      majResume();
    };
    (t.option ? zO : zP).appendChild(b);
  });
  construireDeplacement();
}

function construireDeplacement() {
  const z = $('choixDeplacement'); z.innerHTML = '';
  const prix = P().deplacement;
  $('blocDeplacement').classList.toggle('cache', !prix);
  if (!prix) return;
  const b = el('button', 'presta' + (choisis.some(x => x.nom === 'Déplacement') ? ' on' : ''), 'Déplacement');
  b.appendChild(el('b', '', '+ ' + euros(prix)));
  b.onclick = () => {
    const i = choisis.findIndex(x => x.nom === 'Déplacement');
    if (i >= 0) { choisis.splice(i, 1); b.classList.remove('on'); } else { choisis.push({ nom: 'Déplacement', prix }); b.classList.add('on'); }
    if (!prixManuel) $('prix').value = choisis.length ? sommeChoisis() : '';
    majResume();
  };
  z.appendChild(b);
}

function construirePaiements(zone, quandChoisi) {
  zone.innerHTML = '';
  D.modesPaiement.forEach(m => {
    const b = el('button', 'puce', (ICONES_PAIEMENT[m] || '') + ' ' + m); b.dataset.mode = m;
    b.onclick = () => { zone.querySelectorAll('.puce').forEach(x => x.classList.toggle('on', x === b)); quandChoisi(m); };
    zone.appendChild(b);
  });
}
function selectionnerPaiement(zone, mode) { zone.querySelectorAll('.puce').forEach(x => x.classList.toggle('on', x.dataset.mode === mode)); }

const sommeChoisis = () => Math.round(choisis.reduce((s, x) => s + x.prix, 0) * 100) / 100;
function prixModifie() { prixManuel = true; $('prixAuto').classList.remove('cache'); majResume(); }
function remettrePrixAuto() { prixManuel = false; $('prixAuto').classList.add('cache'); $('prix').value = choisis.length ? sommeChoisis() : ''; majResume(); }

function offreProchaine() {
  if (!cliente || !$('date').value || $('date').value < D.debutOffreIso) return false;
  if (GENERIQUES.includes(cliente.cle)) return false;
  if (!fideliteActive()) return false;
  return (cliente.depuis + 1) % D.passagesPourOffre === 0;
}

function anniversaireCeMois(c) {
  const m = String(c.anniversaire || '').match(/^\s*\d{1,2}\/(\d{1,2})/);
  return !!m && Number(m[1]) === new Date().getMonth() + 1;
}

const texteOffre = o => '−' + Number(o.valeur).toLocaleString('fr-FR') + ' ' + o.type;
function construireChoixOffres() {
  const z = $('choixOffres'); z.innerHTML = '';
  D.offres.filter(o => o.active).forEach(o => {
    const b = el('button', 'presta', o.nom); b.dataset.nom = o.nom;
    b.appendChild(el('b', '', texteOffre(o)));
    b.onclick = () => { offreChoisie = offreChoisie && offreChoisie.nom === o.nom ? null : o; majResume(); };
    z.appendChild(b);
  });
}

function majResume() {
  const prix = nombre($('prix').value) || 0;
  const offre = offreProchaine();
  const f = $('fidelite');
  if (!cliente) f.classList.add('cache');
  else if (offre) {
    f.className = 'fidelite offre';
    f.textContent = '🎁 ' + (cliente.depuis + 1) + 'e passage depuis le ' + D.debutOffre + ' : ' + RED() + ' sur la prestation la plus chère !';
  } else if (!GENERIQUES.includes(cliente.cle) && fideliteActive()) {
    const n = (cliente.depuis % D.passagesPourOffre) + 1, reste = D.passagesPourOffre - n;
    f.className = 'fidelite info';
    f.textContent = 'Fidélité : ' + n + '/' + D.passagesPourOffre + ' — encore ' + reste + ' passage' + (reste > 1 ? 's' : '') + ' avant ' + RED() + '.';
  } else f.classList.add('cache');

  $('blocOffre').classList.toggle('cache', offre || !D.offres.some(o => o.active));
  if (offre) offreChoisie = null;
  document.querySelectorAll('#choixOffres .presta').forEach(b => b.classList.toggle('on', !!offreChoisie && b.dataset.nom === offreChoisie.nom));
  const a = $('anniv');
  if (cliente && anniversaireCeMois(cliente)) { a.classList.remove('cache'); a.textContent = '🎂 C\'est le mois d\'anniversaire de ' + cliente.nom + ' (' + cliente.anniversaire + ').'; }
  else a.classList.add('cache');

  let aPayer = prix;
  if (offre && prix) aPayer = Math.round(((!prixManuel && choisis.length > 1) ? prix - Math.max(...choisis.map(x => x.prix)) * TAUX() : prix * (1 - TAUX())) * 100) / 100;
  else if (offreChoisie && prix) aPayer = Math.max(Math.round((offreChoisie.type === '%' ? prix * (1 - offreChoisie.valeur / 100) : prix - offreChoisie.valeur) * 100) / 100, 0);
  $('encaisser').textContent = prix || choisis.length ? 'À encaisser : ' + euros(aPayer) + (offreChoisie && !offre ? '  (' + offreChoisie.nom + ')' : '') : '';
  return aPayer;
}

function enregistrer() {
  if (!cliente) return message(M('👉 Choisis d\'abord la cliente (étape 1).', '👉 Choisis d\'abord le client (étape 1).'));
  if (!choisis.length) return message('👉 Choisis au moins une prestation (étape 2).');
  if ($('prix').value === '') return message('👉 Indique le prix (étape 3).');
  if (mod('paiement') && !paiementChoisi) return message('👉 Indique comment elle a payé (étape 3).');
  const aPayer = majResume();
  const p = {
    date: $('date').value, heure: $('heure').value, client: cliente.nom, items: choisis.slice(),
    prixManuel: prixManuel ? nombre($('prix').value) : null,
    offre: !offreProchaine() && offreChoisie ? offreChoisie : null,
    paiement: paiementChoisi,
  };
  const item = { action: 'ajouter', uid: uid(), extra: { p }, resume: cliente.nom + ' ' + euros(aPayer) };
  $('btnEnregistrer').disabled = true; $('btnEnregistrer').textContent = 'Enregistrement…';
  api('ajouter', { uid: item.uid, p }).then(j => {
    const r = j.resultat;
    majTout(r.data);
    afficherSucces('✅', 'Enregistré pour ' + p.client,
      r.libelle === D.libelleFidelite ? '🎁 Passage fidélité : ' + RED() + ' appliqué !'
        : r.libelle ? '🏷️ Offre appliquée : ' + r.libelle : (r.passage ? r.passage + 'e passage au total.' : ''),
      typeof r.aEncaisser === 'number' ? r.aEncaisser : aPayer);
  }).catch(e => {
    if (e.horsLigne) {
      horsLigne = true; mettreEnAttente(item);
      afficherSucces('📴', 'Gardé sur le téléphone', 'Pas d\'internet : la saisie de ' + p.client + ' sera envoyée automatiquement dès le retour du réseau.', aPayer);
    } else { $('btnEnregistrer').disabled = false; $('btnEnregistrer').textContent = '✔ Enregistrer'; erreur(e); }
  });
}

function afficherSucces(icone, titre, detail, montant) {
  const bA = $('succesAvis');
  const c = cliente && D.clientes.find(x => x.cle === cliente.cle);
  bA.classList.toggle('cache', !P().avis || !cliente);
  if (P().avis && cliente) bA.href = lienSms(c && c.tel, texteAvis(cliente.nom));
  $('formulaire').classList.add('cache'); $('succes').classList.remove('cache');
  $('succesIcone').textContent = icone; $('succesTitre').textContent = titre; $('succesDetail').textContent = detail;
  $('succesMontant').textContent = 'À encaisser : ' + euros(montant) + (paiementChoisi ? '  ' + (ICONES_PAIEMENT[paiementChoisi] || '') : '');
  window.scrollTo(0, 0);
}

/* ======================= CLIENTES ======================= */
let filtre = 'toutes';
const dateNum = s => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? new Date(+m[3], m[2] - 1, +m[1]).getTime() : 0; };
const RED = () => '−' + ((D && D.reductionFidelite) || 50).toLocaleString('fr-FR') + ' %';
const TAUX = () => ((D && D.reductionFidelite) || 50) / 100;
/* ---------- Modules, métier et vocabulaire (onglet Réglages du Google Sheet) ---------- */
const mod = k => !(D && D.reglages && D.reglages.modules && D.reglages.modules[k] === false);
// « Client » et « Mixte » utilisent le masculin (forme neutre en français), « Cliente » le féminin
const estClient = () => !!(D && D.reglages && (D.reglages.mot === 'Client' || D.reglages.mot === 'Mixte'));
const iconeClients = () => { const m = D && D.reglages && D.reglages.mot; return m === 'Cliente' ? '👩' : m === 'Client' ? '👨' : '👥'; };
const M = (fem, masc) => estClient() ? masc : fem; // ex. M('cliente', 'client')
const icone = () => (D && D.reglages && D.reglages.icone) || '✨';
const P = () => (D && D.reglages && D.reglages.plus) || {};
const nomSalon = () => (D && D.reglages && D.reglages.nomSalon) || 'notre salon';

/* Couleurs de l'application (réglage « Couleur de l'application ») */
const THEMES = {
  'Bleu nuit': ['#1e3a5f', '#3b82c4', '#6aa8dc', '#e8f1fa', '#14284a', '#1e4f8a', '#245f9e'],
  'Vert sauge': ['#3d5a4a', '#6b9a7d', '#93b89f', '#ecf4ee', '#2f4a3c', '#4f7a62', '#4f7a62'],
  'Noir et or': ['#1f1a17', '#b08d57', '#cfb27d', '#f6f0e6', '#111111', '#2b2420', '#8a6b3c'],
  'Terracotta': ['#6b3a2a', '#c8643b', '#e08b66', '#fbede6', '#5a2f22', '#9a4a30', '#a14d2b'],
  'Lavande': ['#4b3f72', '#8a74c9', '#ab9be0', '#f1edfb', '#3a2f5e', '#6a5aa8', '#6a58ac'],
};
function appliquerTheme() {
  const t = THEMES[P().couleur], st = document.documentElement.style;
  ['--prune', '--rose', '--rose-2', '--rose-clair', '--degrade', '--degrade-bouton'].forEach(v => st.removeProperty(v));
  let meta = '#5b2a4e';
  if (t) {
    st.setProperty('--prune', t[0]); st.setProperty('--rose', t[1]); st.setProperty('--rose-2', t[2]); st.setProperty('--rose-clair', t[3]);
    st.setProperty('--degrade', 'linear-gradient(135deg, ' + t[4] + ' 0%, ' + t[5] + ' 55%, ' + t[1] + ' 100%)');
    st.setProperty('--degrade-bouton', 'linear-gradient(135deg, ' + t[1] + ' 0%, ' + t[6] + ' 100%)');
    meta = t[0];
  }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = meta;
}

/* Lien SMS (prérempli) vers un numéro, ou sans numéro si inconnu */
function lienSms(tel, texte) {
  const num = String(tel || '').replace(/[^\d+]/g, '');
  return 'sms:' + num + '?&body=' + encodeURIComponent(texte);
}
const texteAvis = nom => 'Bonjour ' + nom + ', merci pour votre visite chez ' + nomSalon() + ' ! Si vous avez une minute, votre avis nous aiderait beaucoup : ' + P().avis;
const texteRelance = nom => 'Bonjour ' + nom + ', cela fait un moment ! Au plaisir de vous revoir chez ' + nomSalon() + '. Répondez à ce message pour prendre rendez-vous 😊';

function appliquerReglages() {
  ['fidelite', 'offres', 'options', 'paiement', 'achats', 'fiche', 'heure']
    .forEach(k => document.body.classList.toggle('sans-' + k, !mod(k)));
  document.querySelectorAll('[data-mot]').forEach(e => { const [f, m] = e.dataset.mot.split('|'); e.textContent = estClient() ? m : f; });
  $('titrePrestations').textContent = icone() + ' Prestations';
  $('iconeClients').textContent = iconeClients();
  $('ficheNotes').placeholder = (D.reglages && D.reglages.notes) || 'Préférences, allergies, remarques…';
  appliquerTheme();
  const j = P().relance || 60;
  const fAbs = document.querySelector('[data-f="absente"]');
  fAbs.textContent = M('💤 Pas venue depuis ', '💤 Pas venu depuis ') + j + ' jours';
  $('recherche').placeholder = 'Tape le prénom…';
  if (!mod('achats') && vueActive === 'achats') vue('nouvelle');
}

const fideliteActive = () => mod('fidelite') && (!D.fidelite || D.fidelite.etat === 'active');
const prochesOffre = c => fideliteActive() && c.depuis % D.passagesPourOffre === D.passagesPourOffre - 1;
const absente = c => c.total > 0 && dateNum(c.derniere) && (Date.now() - dateNum(c.derniere)) > (P().relance || 60) * 864e5;

function pointsFidelite(c) {
  const n = c.depuis % D.passagesPourOffre, pts = el('div', 'points');
  for (let i = 1; i <= D.passagesPourOffre; i++) pts.appendChild(el('i', i <= n ? 'plein' : (i === D.passagesPourOffre ? 'cadeau' : '')));
  return pts;
}

function afficherClientes() {
  const q = norm($('rechercheClientes').value);
  const box = $('listeClientes'); box.innerHTML = '';
  let liste = D.clientes.filter(c => !q || norm(c.nom).includes(q));
  if (filtre === 'offre') liste = liste.filter(prochesOffre);
  if (filtre === 'anniv') liste = liste.filter(anniversaireCeMois);
  if (filtre === 'absente') liste = liste.filter(absente);
  if (filtre === 'regulieres') liste = liste.filter(c => c.total >= 5);
  const parNom = (a, b) => a.nom.localeCompare(b.nom, 'fr');
  liste.sort({
    nom: parNom,
    recente: (a, b) => dateNum(b.derniere) - dateNum(a.derniere) || parNom(a, b),
    passages: (a, b) => b.total - a.total || parNom(a, b),
    ca: (a, b) => b.ca - a.ca || parNom(a, b),
    offre: (a, b) => (b.depuis % D.passagesPourOffre) - (a.depuis % D.passagesPourOffre) || parNom(a, b),
  }[$('tri').value]);
  $('nbClientes').textContent = liste.length + ' ' + M('cliente', 'client') + (liste.length > 1 ? 's' : '');
  if (!liste.length) box.appendChild(el('p', 'discret', M('Aucune cliente ne correspond.', 'Aucun client ne correspond.')));
  liste.forEach(c => {
    const k = el('div', 'carte cliquable');
    const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', c.nom));
    if (prochesOffre(c)) l1.appendChild(el('span', 'badge', '🎁 ' + RED() + ' au prochain'));
    else l1.appendChild(el('span', 'chevron', '›'));
    k.appendChild(l1);
    const infos = [c.total + ' passage' + (c.total > 1 ? 's' : '')];
    if (c.derniere) infos.push('vue le ' + c.derniere);
    if (c.anniversaire) infos.push('🎂 ' + c.anniversaire);
    if (c.ca) infos.push(euros(c.ca));
    if (c.tel) infos.push('📞');
    k.appendChild(el('div', 'ligne2', infos.join(' · ')));
    if (fideliteActive()) k.appendChild(pointsFidelite(c));
    k.onclick = () => ouvrirFiche(c.cle);
    box.appendChild(k);
  });
}

/* ======================= FICHE CLIENTE ======================= */
let ficheCle = null;

function ouvrirFiche(cle, rafraichissement) {
  const c = D.clientes.find(x => x.cle === cle);
  if (!c) { if (!rafraichissement) message('Cliente introuvable.'); return vue('clientes'); }
  ficheCle = cle;
  $('ficheNom').textContent = c.nom;
  $('ficheNomBouton').textContent = c.nom;
  $('ficheSous').textContent = [c.nomFamille, c.derniere ? 'dernière visite le ' + c.derniere : 'pas encore venue', c.anniversaire ? '🎂 ' + c.anniversaire : '']
    .filter(Boolean).join(' · ');
  const pts = $('fichePoints'); pts.replaceWith(Object.assign(pointsFidelite(c), { id: 'fichePoints' }));
  const reste = D.passagesPourOffre - (c.depuis % D.passagesPourOffre);
  $('ficheFidelite').textContent = !fideliteActive() ? 'Offre fidélité ' + (D.fidelite.etat === 'pause' ? 'en pause' : 'arrêtée') + '.'
    : reste === 1 ? '🎁 ' + RED() + ' à sa prochaine visite !' : 'Encore ' + reste + ' passages avant ' + RED() + '.';
  $('fichePassages').textContent = c.total;
  $('ficheCa').textContent = euros(c.ca);
  if (!rafraichissement) {
    $('fichePrenom').value = c.nom;
    $('ficheTel').value = c.tel || ''; $('ficheNomFamille').value = c.nomFamille || '';
    $('ficheAnniv').value = c.anniversaire || ''; $('ficheNotes').value = c.notes || '';
  }
  majContact();
  $('ficheTel').oninput = majContact;
  remplirFusion(c);

  const h = $('ficheHistorique'); h.innerHTML = '';
  const lignes = D.journal.filter(r => r.cle === cle).reverse();
  if (!lignes.length) h.appendChild(el('p', 'discret', 'Aucune prestation enregistrée.'));
  lignes.forEach(r => h.appendChild(carteSaisie(r, false)));
  if (!rafraichissement) vue('fiche');
}

function majContact() {
  const tel = $('ficheTel').value.replace(/[^\d+]/g, '');
  // Appeler / SMS seulement avec un numéro ; Avis et Relancer restent disponibles (SMS sans destinataire)
  $('ficheAppel').classList.toggle('cache', tel.length < 6);
  $('ficheSms').classList.toggle('cache', tel.length < 6);
  $('ficheAppel').href = 'tel:' + tel;
  const c = D.clientes.find(x => x.cle === ficheCle);
  $('ficheSms').href = 'sms:' + tel + '?&body=' + encodeURIComponent('Bonjour ' + (c ? c.nom : '') + ', ');
  $('ficheRelance').classList.toggle('cache', !(c && absente(c)));
  if (c) $('ficheRelance').href = lienSms(tel, texteRelance(c.nom));
  $('ficheAvis').classList.toggle('cache', !P().avis);
  if (c) $('ficheAvis').href = lienSms(tel, texteAvis(c.nom));
}

function sauverFiche() {
  const c = D.clientes.find(x => x.cle === ficheCle);
  if (!c) return;
  const anniv = $('ficheAnniv').value.trim();
  if (anniv && !/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(anniv)) return message('👉 Anniversaire au format jour/mois, ex. 09/04.');
  const prenom = $('fichePrenom').value.trim();
  if (!prenom) return message('👉 Le prénom ne peut pas être vide.');
  const renomme = prenom !== c.nom;
  if (renomme && !confirm('Renommer « ' + c.nom + ' » en « ' + prenom + ' » ?\n\nToutes ses saisies passeront à ce nouveau nom.')) return;
  $('btnFiche').disabled = true;
  api('cliente', { c: { cle: c.cle, nom: c.nom, nouveauNom: renomme ? prenom : '', tel: $('ficheTel').value, nomFamille: $('ficheNomFamille').value, anniversaire: anniv, notes: $('ficheNotes').value } })
    .then(j => {
      if (renomme) ficheCle = norm(prenom);
      majTout(j.data); ouvrirFiche(ficheCle);
      message('✅ Fiche de ' + prenom + ' enregistrée.');
    })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { $('btnFiche').disabled = false; });
}

function remplirFusion(c) {
  $('ficheNomFusion').textContent = c.nom;
  const s = $('ficheFusion'); s.innerHTML = '';
  s.appendChild(new Option('Choisir l\'autre fiche…', ''));
  D.clientes.filter(x => x.cle !== c.cle).forEach(x => s.appendChild(new Option(x.nom + ' (' + x.total + ' passage' + (x.total > 1 ? 's' : '') + ')', x.cle)));
}

function fusionnerFiche() {
  const c = D.clientes.find(x => x.cle === ficheCle);
  const autre = D.clientes.find(x => x.cle === $('ficheFusion').value);
  if (!c || !autre) return message('👉 Choisis l\'autre fiche à regrouper.');
  if (!confirm('Regrouper « ' + autre.nom + ' » (' + autre.total + ' passage' + (autre.total > 1 ? 's' : '') + ') dans « ' + c.nom + ' » ?\n\n' +
    'Toutes ses saisies passeront au nom « ' + c.nom + ' » et la fiche « ' + autre.nom + ' » sera retirée.')) return;
  $('btnFusion').disabled = true;
  api('fusionner', { source: autre.nom, cible: c.nom })
    .then(j => { majTout(j.data); ouvrirFiche(c.cle); message('✅ « ' + autre.nom + ' » regroupée dans « ' + c.nom + ' ».'); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { $('btnFusion').disabled = false; });
}

function prestationPourFiche() {
  const c = D.clientes.find(x => x.cle === ficheCle);
  nouvelleSaisie(); if (c) choisirCliente(c); vue('nouvelle');
}

/** Carte d'une saisie (historique, dernières saisies) avec bouton Modifier. */
function carteSaisie(r, avecNom) {
  const k = el('div', 'carte');
  const l1 = el('div', 'ligne1');
  l1.appendChild(el('span', '', avecNom ? r.client : r.date));
  l1.appendChild(el('span', '', r.caApres !== null ? euros(r.caApres) : r.prixTexte));
  k.appendChild(l1);
  const det = [];
  if (avecNom) det.push(r.date);
  if (r.heure) det.push(r.heure);
  det.push(r.prestation);
  if (r.libelle) det.push(r.libelle === D.libelleFidelite ? '🎁 ' + RED() + '' : '🏷️ ' + r.libelle);
  if (r.paiement) det.push((ICONES_PAIEMENT[r.paiement] || '') + ' ' + r.paiement);
  k.appendChild(el('div', 'ligne2', det.join(' · ')));
  const b = el('button', 'lien', '✏️ Modifier');
  b.onclick = () => ouvrirModification(r.id);
  k.appendChild(b);
  return k;
}

/* ======================= MODIFIER UNE SAISIE ======================= */
let enEdition = null, paiementEdition = null;

function remplirNoms() {
  const dl = $('listeNoms'); dl.innerHTML = '';
  D.clientes.forEach(c => dl.appendChild(new Option(c.nom)));
}

function ouvrirModification(id) {
  const r = D.journal.find(x => x.id === id);
  if (!r) return message('Saisie introuvable.');
  enEdition = r;
  $('mDate').value = r.iso; $('mHeure').value = heureVersChamp(r.heure);
  $('mClient').value = r.client; $('mPrestation').value = r.prestation;
  $('mPrix').value = r.prix !== null ? r.prix : '';
  paiementEdition = r.paiement || null;
  construirePaiements($('mPaiement'), m => { paiementEdition = m; });
  selectionnerPaiement($('mPaiement'), paiementEdition);

  const s = $('mOffre'); s.innerHTML = '';
  s.appendChild(new Option('Aucune offre', ''));
  D.offres.forEach(o => s.appendChild(new Option(o.nom + ' (' + texteOffre(o) + ')' + (o.active ? '' : ' – en pause'), 'o:' + o.nom)));
  const actuelle = !r.fidelite && r.libelle ? D.offres.find(o => r.libelle.indexOf(o.nom) === 0) : null;
  if (r.libelle && !r.fidelite && !actuelle) s.appendChild(new Option(r.libelle, 'l:' + r.libelle));
  s.value = actuelle ? 'o:' + actuelle.nom : (r.libelle && !r.fidelite ? 'l:' + r.libelle : '');
  $('mBlocOffre').classList.toggle('cache', r.fidelite || !r.apresDebut);
  const info = $('mInfo');
  if (r.fidelite) { info.classList.remove('cache'); info.textContent = '🎁 Passage fidélité : le ' + RED() + ' est appliqué automatiquement.'; }
  else if (!r.apresDebut) { info.classList.remove('cache'); info.textContent = 'Saisie d\'avant le ' + D.debutOffre + ' : l\'offre ne se change pas ici.'; }
  else info.classList.add('cache');

  $('modale').classList.remove('cache');
  document.body.style.overflow = 'hidden';
}

function fermerModale() { $('modale').classList.add('cache'); document.body.style.overflow = ''; enEdition = null; }

function validerModification() {
  if (!enEdition) return;
  const v = $('mOffre').value;
  const offre = v.indexOf('o:') === 0 ? D.offres.find(o => o.nom === v.slice(2)) : null;
  const m = {
    date: $('mDate').value, heure: $('mHeure').value, client: $('mClient').value.trim(), prestation: $('mPrestation').value.trim(),
    prix: $('mPrix').value === '' ? null : nombre($('mPrix').value), paiement: paiementEdition,
    offre: offre || null, offreLibelle: v.indexOf('l:') === 0 ? v.slice(2) : '',
  };
  if (!m.client) return message('👉 Indique la cliente.');
  if (!m.prestation) return message('👉 Indique la prestation.');
  if (m.date.slice(0, 4) !== enEdition.id.slice(0, 4)) return message('👉 Pour changer d\'année, supprime la saisie et refais-la.');
  $('btnModifier').disabled = true;
  api('modifier', { id: enEdition.id, m })
    .then(j => { fermerModale(); majTout(j.data); message('✅ Saisie modifiée.'); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { $('btnModifier').disabled = false; });
}

function supprimerSaisie() {
  if (!enEdition) return;
  if (!confirm('Supprimer définitivement la saisie de ' + enEdition.client + ' du ' + enEdition.date + ' (' + enEdition.prestation + ') ?')) return;
  api('supprimer', { id: enEdition.id })
    .then(j => { fermerModale(); majTout(j.data); message('🗑 Saisie supprimée.'); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e));
}

/* ======================= TARIFS ======================= */
let tarifsEdition = null;

function afficherTarifs() {
  tarifsEdition = D.tarifs.map(t => Object.assign({}, t));
  dessinerTarifs();
}
function dessinerTarifs() {
  [['tarifsPrestations', false], ['tarifsOptions', true]].forEach(([zone, opt]) => {
    const z = $(zone); z.innerHTML = '';
    tarifsEdition.forEach((t, i) => {
      if (!!t.option !== opt) return;
      const ligne = el('div', 'ligne-tarif');
      const nom = el('input'); nom.type = 'text'; nom.value = t.nom; nom.placeholder = 'Nom';
      nom.oninput = () => { t.nom = nom.value; };
      const prix = el('input'); prix.type = 'number'; prix.inputMode = 'decimal'; prix.value = t.prix; prix.className = 'prix-tarif';
      prix.oninput = () => { t.prix = nombre(prix.value) || 0; };
      const sup = el('button', 'supprimer', '✕'); sup.title = 'Retirer';
      sup.onclick = () => { tarifsEdition.splice(i, 1); dessinerTarifs(); };
      ligne.appendChild(nom); ligne.appendChild(prix); ligne.appendChild(el('span', 'euro', '€')); ligne.appendChild(sup);
      z.appendChild(ligne);
    });
  });
}
function ajouterLigneTarif(option) {
  tarifsEdition.push({ nom: '', prix: 0, option });
  dessinerTarifs();
  const zone = $(option ? 'tarifsOptions' : 'tarifsPrestations');
  const champs = zone.querySelectorAll('input[type=text]');
  if (champs.length) champs[champs.length - 1].focus();
}
function sauverTarifs() {
  const liste = tarifsEdition.filter(t => String(t.nom).trim());
  const noms = liste.map(t => norm(t.nom));
  if (noms.some((n, i) => noms.indexOf(n) !== i)) return message('👉 Deux lignes ont le même nom.');
  $('btnTarifs').disabled = true;
  api('tarifs', { tarifs: liste })
    .then(j => { majTout(j.data); message('✅ Tarifs enregistrés.'); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { $('btnTarifs').disabled = false; });
}

/* ======================= OFFRES ======================= */
let typeOffre = '%';
function choisirType(t) { typeOffre = t; $('typePct').classList.toggle('on', t === '%'); $('typeEur').classList.toggle('on', t === '€'); }

function sauverOffres(liste, msg) {
  api('offres', { offres: liste }).then(j => { majTout(j.data); message(msg); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e));
}

function creerOffre() {
  const nom = $('offreNom').value.trim();
  const valeur = nombre($('offreValeur').value);
  if (!nom) return message('👉 Donne un nom à l\'offre.');
  if (!(valeur > 0)) return message('👉 Indique le montant de la réduction.');
  if (typeOffre === '%' && valeur > 100) return message('👉 Le pourcentage ne peut pas dépasser 100.');
  if (D.offres.some(o => norm(o.nom) === norm(nom))) return message('👉 Une offre porte déjà ce nom.');
  $('offreNom').value = ''; $('offreValeur').value = '';
  sauverOffres(D.offres.concat([{ nom, type: typeOffre, valeur, active: true }]), '✅ Offre « ' + nom + ' » créée.');
}

function changerFidelite(etat, msg) {
  api('fidelite', { etat }).then(j => { majTout(j.data); message(msg); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e));
}

function afficherFidelite() {
  const z = $('carteFidelite'); z.innerHTML = '';
  const etat = D.fidelite ? D.fidelite.etat : 'active';
  if (etat === 'supprimee') {
    const b = el('button', 'lien', '➕ Remettre l\'offre fidélité (' + RED() + ' au ' + D.passagesPourOffre + 'e passage)');
    b.onclick = () => changerFidelite('active', '🎁 Offre fidélité remise en place.');
    z.appendChild(b);
    return;
  }
  const active = etat === 'active';
  const k = el('div', 'carte ' + (active ? 'offre-active' : 'offre-pause'));
  const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', '🎁 Fidélité (automatique)')); l1.appendChild(el('span', '', RED()));
  k.appendChild(l1);
  k.appendChild(el('div', 'ligne2', '' + RED() + ' sur la prestation la plus chère au ' + D.passagesPourOffre + 'e passage depuis le ' + D.debutOffre + ', puis au ' + 2 * D.passagesPourOffre + 'e, ' + 3 * D.passagesPourOffre + 'e…'));
  k.appendChild(el('div', 'ligne2 etat', active ? '✅ Active : appliquée automatiquement' : '⏸ En pause : pas de ' + RED() + ' sur les passages à partir de la pause'));
  const act = el('div', 'actions');
  const bP = el('button', 'lien', active ? '⏸ Mettre en pause' : '▶ Réactiver');
  bP.onclick = () => {
    if (active && !confirm('Mettre la fidélité en pause ?\n\nLes réductions déjà faites restent. Les passages à partir d\'aujourd\'hui ne donneront pas de ' + RED() + ' tant qu\'elle est en pause.')) return;
    changerFidelite(active ? 'pause' : 'active', active ? 'Fidélité mise en pause.' : '🎁 Fidélité réactivée.');
  };
  const bS = el('button', 'lien danger', '🗑 Supprimer');
  bS.onclick = () => {
    if (confirm('Supprimer l\'offre fidélité ?\n\nLes réductions déjà faites restent, mais plus aucun ' + RED() + ' ne sera appliqué à partir d\'aujourd\'hui. Tu pourras la remettre plus tard.')) {
      changerFidelite('supprimee', 'Offre fidélité supprimée.');
    }
  };
  act.appendChild(bP); act.appendChild(bS); k.appendChild(act);
  z.appendChild(k);
}

function afficherOffres() {
  afficherFidelite();
  const box = $('listeOffres'); box.innerHTML = '';
  if (!D.offres.length) box.appendChild(el('p', 'discret', 'Aucune autre offre pour l\'instant.'));
  D.offres.forEach((o, i) => {
    const k = el('div', 'carte ' + (o.active ? 'offre-active' : 'offre-pause'));
    const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', '🏷️ ' + o.nom)); l1.appendChild(el('span', '', texteOffre(o)));
    k.appendChild(l1);
    k.appendChild(el('div', 'ligne2', o.active ? 'Active : proposée à la saisie' : 'En pause : non proposée'));
    const act = el('div', 'actions');
    const bP = el('button', 'lien', o.active ? '⏸ Mettre en pause' : '▶ Réactiver');
    bP.onclick = () => sauverOffres(D.offres.map((x, j) => j === i ? Object.assign({}, x, { active: !x.active }) : x), o.active ? 'Offre mise en pause.' : 'Offre réactivée.');
    const bS = el('button', 'lien danger', '🗑 Supprimer');
    bS.onclick = () => { if (confirm('Supprimer l\'offre « ' + o.nom + ' » ?')) sauverOffres(D.offres.filter((x, j) => j !== i), 'Offre supprimée.'); };
    act.appendChild(bP); act.appendChild(bS); k.appendChild(act);
    box.appendChild(k);
  });

  const sv = $('surveiller'); sv.innerHTML = '';
  const bloc = (titre, liste, detail) => {
    const k = el('div', 'carte');
    k.appendChild(el('div', 'ligne1', titre + ' (' + liste.length + ')'));
    const l = el('div', 'liens-clientes');
    if (!liste.length) l.appendChild(el('span', 'discret', 'Personne pour l\'instant.'));
    liste.forEach(c => { const b = el('button', 'puce', detail(c)); b.onclick = () => ouvrirFiche(c.cle); l.appendChild(b); });
    k.appendChild(l);
    sv.appendChild(k);
  };
  bloc('🎁 ' + RED() + ' à leur prochaine visite', D.clientes.filter(prochesOffre), c => c.nom);
  bloc('🎂 Anniversaire ce mois-ci', D.clientes.filter(anniversaireCeMois), c => c.nom + ' (' + c.anniversaire + ')');
  bloc('💤 À relancer (plus de ' + (P().relance || 60) + ' jours)', D.clientes.filter(absente), c => c.nom + ' (' + c.derniere + ')');
}

/* ======================= ACHATS ======================= */
let categorieAchat = null;
const iconeCat = c => ICONES_CAT[c] || '📦';

function initAchats() {
  const z = $('achatCategories'); z.innerHTML = '';
  D.categoriesAchats.forEach(c => {
    const b = el('button', 'presta', iconeCat(c) + ' ' + c); b.dataset.cat = c;
    b.onclick = () => { categorieAchat = c; z.querySelectorAll('.presta').forEach(x => x.classList.toggle('on', x === b)); };
    z.appendChild(b);
  });
  const f = $('achatFiltre'); f.innerHTML = '';
  f.appendChild(new Option('Toutes les catégories', ''));
  D.categoriesAchats.forEach(c => f.appendChild(new Option(iconeCat(c) + ' ' + c, c)));
  resetAchat();
}

function resetAchat() {
  $('achatLibelle').value = ''; $('achatPrix').value = ''; $('achatQte').value = 1;
  $('achatDate').value = isoAujourdhui();
  categorieAchat = null; document.querySelectorAll('#achatCategories .presta').forEach(x => x.classList.remove('on'));
  majTotalAchat();
}

function majTotalAchat() {
  const pu = nombre($('achatPrix').value) || 0, q = Number($('achatQte').value) || 1;
  $('achatTotal').textContent = pu ? 'Total : ' + euros(pu * q) + (q > 1 ? '  (' + q + ' × ' + euros(pu) + ')' : '') : '';
}

function enregistrerAchat() {
  const libelle = $('achatLibelle').value.trim();
  const pu = nombre($('achatPrix').value), q = Number($('achatQte').value) || 1;
  if (!libelle) return message('👉 Indique ce que tu as acheté.');
  if (!categorieAchat) return message('👉 Choisis une catégorie.');
  if (!(pu > 0)) return message('👉 Indique le prix TTC.');
  const a = { date: $('achatDate').value, libelle, categorie: categorieAchat, prixUnitaire: pu, quantite: q };
  const item = { action: 'achat_ajouter', uid: uid(), extra: { a }, resume: libelle };
  $('btnAchat').disabled = true; $('btnAchat').textContent = 'Enregistrement…';
  api('achat_ajouter', { uid: item.uid, a })
    .then(j => { majTout(j.data.doublon ? j.data.data : j.data); resetAchat(); message('✅ Achat enregistré : ' + libelle + ' (' + euros(pu * q) + ')'); })
    .catch(e => {
      if (e.horsLigne) { horsLigne = true; mettreEnAttente(item); resetAchat(); message('📴 Pas d\'internet : achat gardé sur le téléphone, envoyé au retour du réseau.', 6000); }
      else erreur(e);
    })
    .finally(() => { $('btnAchat').disabled = false; $('btnAchat').textContent = '✔ Enregistrer l\'achat'; });
}

function afficherAchats() {
  const f = $('achatFiltre').value;
  const liste = D.achats.filter(a => !f || a.categorie === f);
  const total = liste.reduce((s, a) => s + a.total, 0);
  $('achatsResume').textContent = liste.length + ' achat' + (liste.length > 1 ? 's' : '') + ' · ' + euros(total) + ' TTC';
  const box = $('listeAchats'); box.innerHTML = '';
  if (!liste.length) box.appendChild(el('p', 'discret', 'Aucun achat pour l\'instant.'));
  liste.forEach(a => {
    const k = el('div', 'carte');
    const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', iconeCat(a.categorie) + ' ' + a.libelle)); l1.appendChild(el('span', '', euros(a.total)));
    k.appendChild(l1);
    k.appendChild(el('div', 'ligne2', a.date + ' · ' + a.categorie + (a.q > 1 ? ' · ' + a.q + ' × ' + euros(a.pu) : '')));
    const b = el('button', 'lien danger', '🗑 Supprimer');
    b.onclick = () => {
      if (!confirm('Supprimer l\'achat « ' + a.libelle + ' » (' + euros(a.total) + ') ?')) return;
      api('achat_supprimer', { row: a.row }).then(j => { majTout(j.data); message('Achat supprimé.'); })
        .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e));
    };
    k.appendChild(b);
    box.appendChild(k);
  });
}

/* ======================= BILAN ======================= */
function barres(zone, valeurs, icone, vide) {
  zone.innerHTML = '';
  const cles = Object.keys(valeurs).filter(k => valeurs[k]).sort((a, b) => valeurs[b] - valeurs[a]);
  const total = cles.reduce((s, k) => s + valeurs[k], 0), max = cles.length ? valeurs[cles[0]] : 0;
  if (!cles.length) zone.appendChild(el('div', 'ligne2', vide));
  cles.forEach(c => {
    const v = valeurs[c], k = el('div', 'cat');
    const l = el('div', 'ligne1'); l.appendChild(el('span', '', icone(c) + ' ' + c)); l.appendChild(el('span', '', euros(v) + ' · ' + Math.round(v / total * 100) + ' %'));
    k.appendChild(l);
    const b = el('div', 'barre'); b.style.width = Math.max(4, v / max * 100) + '%'; k.appendChild(b);
    zone.appendChild(k);
  });
}

function afficherBilan() {
  $('jourNb').textContent = D.jour.nb; $('jourCa').textContent = euros(D.jour.ca);
  $('titreAnnee').textContent = 'Mois par mois (' + D.annee + ')';
  $('titreBilanAnnee').textContent = 'Bilan ' + D.annee;
  const tb = $('tableMois'); tb.innerHTML = '';
  let tc = 0, ta = 0;
  const cellule = (v, neg) => el('td', 'n' + (neg ? ' negatif' : ''), euros(v));
  const celluleA = (v, neg) => el('td', 'n m-achats' + (neg ? ' negatif' : ''), euros(v));
  D.mois.forEach((m, i) => {
    const dep = D.achatsMois[i] || 0;
    if (!m.nb && !dep) return; tc += m.ca; ta += dep;
    const tr = el('tr'); tr.appendChild(el('td', '', MOIS[i]));
    tr.appendChild(cellule(m.ca)); tr.appendChild(celluleA(dep)); tr.appendChild(celluleA(m.ca - dep, m.ca - dep < 0));
    tb.appendChild(tr);
  });
  const tr = el('tr', 'total-ligne');
  tr.appendChild(el('td', '', 'Total')); tr.appendChild(cellule(tc)); tr.appendChild(celluleA(ta)); tr.appendChild(celluleA(tc - ta, tc - ta < 0));
  tb.appendChild(tr);
  $('anCa').textContent = euros(tc); $('anAchats').textContent = euros(ta); $('anReste').textContent = euros(tc - ta);
  $('anReste').classList.toggle('negatif', tc - ta < 0);

  const jauge = (zone, titre, valeur, cible, detail, alerteDes) => {
    zone.innerHTML = '';
    const p = cible ? Math.min(valeur / cible, 1) : 0;
    zone.classList.toggle('alerte', !!alerteDes && valeur / cible >= alerteDes);
    const l = el('div', 'ligne1'); l.appendChild(el('span', '', titre)); l.appendChild(el('span', '', Math.round(valeur / cible * 100) + ' %'));
    zone.appendChild(l);
    const f = el('div', 'fond'), pl = el('div', 'plein'); pl.style.width = (p * 100) + '%'; f.appendChild(pl); zone.appendChild(f);
    zone.appendChild(el('div', 'ligne2', detail));
  };
  const moisCourant = new Date().getMonth();
  const caMois = (D.mois[moisCourant] || { ca: 0 }).ca;
  $('carteObjectif').classList.toggle('cache', !P().objectif);
  if (P().objectif) jauge($('carteObjectif'), '🎯 Objectif de ' + MOIS[moisCourant].toLowerCase(), caMois, P().objectif,
    euros(caMois) + ' sur ' + euros(P().objectif) + (caMois < P().objectif ? ' · encore ' + euros(P().objectif - caMois) : ' · objectif atteint 🎉'));
  $('carteSeuil').classList.toggle('cache', !P().seuil);
  if (P().seuil) jauge($('carteSeuil'), '📈 Plafond micro-entreprise ' + D.annee, tc, P().seuil,
    euros(tc) + ' sur ' + euros(P().seuil) + (tc / P().seuil >= 0.8 ? ' · ⚠️ attention, le plafond approche' : ''), 0.8);
  const cu = $('carteUrssaf'); cu.innerHTML = '';
  cu.classList.toggle('cache', !P().urssaf);
  if (P().urssaf) {
    const taux = P().urssaf / 100;
    const l = el('div', 'ligne1'); l.appendChild(el('span', '', '🏛️ Cotisations à mettre de côté')); l.appendChild(el('span', '', P().urssaf.toLocaleString('fr-FR') + ' %'));
    cu.appendChild(l);
    cu.appendChild(el('div', 'ligne2', 'Ce mois-ci : ' + euros(caMois * taux) + ' · depuis janvier : ' + euros(tc * taux)));
    cu.appendChild(el('div', 'ligne2', 'Estimation sur le chiffre d\'affaires encaissé. Le montant exact est celui de ta déclaration URSSAF.'));
  }

  barres($('paiements'), D.parPaiement, m => ICONES_PAIEMENT[m] || '💰', 'Aucun encaissement cette année.');
  barres($('categories'), D.parCategorie, iconeCat, 'Aucun achat enregistré cette année. Ajoute-les dans l\'onglet 🧾 Achats.');

  const box = $('recentes'); box.innerHTML = '';
  D.journal.slice(-20).reverse().forEach(r => box.appendChild(carteSaisie(r, true)));
}

/* ---------- Démarrage ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* facultatif */ });
enTeteDepuisCache(); // en-tête du salon dès l'ouverture (dernière visite)
charger();
