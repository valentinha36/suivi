/* ===== Suivi Ongles – application ===== */
'use strict';

/* Salon de la cliente : donné une fois dans le lien, puis mémorisé sur l'appareil.
   - ?salon=<identifiant du Google Sheet> → serveur central (mises à jour pour toutes les clientes en une fois)
   - ?api=<adresse d'une application déployée> → ancien format, toujours accepté */
const SERVEUR_CENTRAL = 'https://script.google.com/macros/s/AKfycbxWejimyOL5FGpNqy3qYO6JLQZswiVAsl_CDho2ueERr3MP3WwFob3f8E_UDSnLzZQE/exec';
const API_VALIDE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/;
const SALON_VALIDE = /^[\w-]{25,80}$/;
// Lien « nouveau code » reçu par e-mail (lu avant que l'adresse soit nettoyée)
const RESET = (() => { try { const r = new URLSearchParams(location.search).get('reset') || ''; return /^[0-9a-f]{64}$/.test(r) ? r : ''; } catch (e) { return ''; } })();
const RETOUR_PAIEMENT = (() => { try { return new URLSearchParams(location.search).get('abonnement') === 'ok'; } catch (e) { return false; } })();
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
  if (!j.ok) {
    if (j.erreur === 'ABONNEMENT') { if (D && D.abonnement) D.abonnement.bloque = true; afficherPaywall(); throw new Error('Ton abonnement est terminé : tes données restent consultables. Abonne-toi pour enregistrer à nouveau.'); }
    throw new Error(j.erreur);
  }
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
        if (item.action.indexOf('rdv') === 0) { horsLigne = false; if (!fileAttente().slice(1).some(x => x.action.indexOf('rdv') === 0)) majAgenda(j.data.agenda); }
        else { dernieres = item.action === 'ajouter' ? (j.resultat.data || j.resultat) : (j.data.data || j.data); envoyees++; }
      } catch (e) {
        if (e.horsLigne) { horsLigne = true; break; }
        erreur('Saisie en attente refusée (' + (item.resume || '') + ') : ' + e.message);
      }
      l = fileAttente(); l.shift(); ecrireAttente(l);
    }
  } finally {
    envoiEnCours = false;
  }
  if (envoyees) { horsLigne = false; majTout(dernieres); message('✅ ' + (envoyees > 1 ? envoyees + ' saisies enregistrées' : 'Saisie enregistrée') + ' dans le Google Sheet.', 2500); }
  majBandeau();
}

/** Petit indicateur discret pendant la mise à jour depuis le Google Sheet. */
function majBandeauSync(actif) { document.body.classList.toggle('synchro', !!actif); }

function majBandeau() {
  const n = fileAttente().length, b = $('bandeau');
  if (!n && !horsLigne) { b.classList.add('cache'); return; }
  b.classList.remove('cache');
  b.textContent = horsLigne
    ? '📴 Pas d\'internet' + (n ? ' · ' + n + ' saisie' + (n > 1 ? 's' : '') + ' en attente, envoi automatique au retour du réseau' : ' · données du dernier chargement')
    : '⏳ Enregistrement dans le Google Sheet…' + (n > 1 ? ' (' + n + ')' : '');
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
let resetTraite = false;
function afficherResetEmail() {
  demanderPin('');
  ['pin', 'lienOubli'].forEach(id => $(id).classList.add('cache'));
  document.querySelector('#v-pin > .gros').classList.add('cache');
  $('resetEmail').classList.remove('cache'); $('resetPin').focus();
}
function validerResetEmail() {
  const pin = $('resetPin').value.trim();
  if (!/^\d{4,8}$/.test(pin)) return message('👉 Le nouveau code doit faire de 4 à 8 chiffres.');
  if (pin !== $('resetPin2').value.trim()) return message('👉 Les deux codes ne sont pas identiques.');
  const b = $('btnReset'); b.disabled = true;
  api('nouveau_code_email', { jeton: RESET, pin })
    .then(() => {
      resetTraite = true; PIN = pin; lsSet(CLE_PIN, pin);
      $('resetEmail').classList.add('cache');
      ['pin', 'lienOubli'].forEach(id => $(id).classList.remove('cache'));
      document.querySelector('#v-pin > .gros').classList.remove('cache');
      message('✅ Nouveau code enregistré.');
      $('v-pin').classList.add('cache'); $('chargement').classList.remove('cache');
      charger();
    })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { b.disabled = false; });
}
function demanderEmailCode() {
  const b = $('btnOubliEmail'); b.disabled = true; $('oubliEmailMsg').textContent = 'Envoi en cours…';
  api('oubli_email')
    .then(j => { $('oubliEmailMsg').textContent = '✅ Lien envoyé à ' + j.data.email + '. Ouvre l\'e-mail sur ce téléphone (pense à regarder dans les spams). Le lien est valable 1 heure.'; })
    .catch(e => { $('oubliEmailMsg').textContent = '⚠️ ' + (e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e.message); })
    .finally(() => { b.disabled = false; });
}
function ouvrirOubli() {
  if (!SALON) return message('Contacte la personne qui t\'a donné l\'application pour retrouver ton code.', 6000);
  $('oubli').classList.remove('cache'); $('lienOubli').classList.add('cache'); $('oubliSecours').focus();
}
function validerOubli() {
  const secours = $('oubliSecours').value.trim(), pin = $('oubliPin').value.trim();
  if (secours.replace(/[^A-Za-z0-9]/g, '').length < 12) return message('👉 Le code de secours a 12 caractères (ex. K7MQ-4PXA-92HT).');
  if (!/^\d{4,8}$/.test(pin)) return message('👉 Le nouveau code doit faire de 4 à 8 chiffres.');
  if (pin !== $('oubliPin2').value.trim()) return message('👉 Les deux codes ne sont pas identiques.');
  const b = $('btnOubli'); b.disabled = true;
  api('nouveau_code', { secours, pin })
    .then(() => {
      PIN = pin; lsSet(CLE_PIN, pin);
      $('oubli').classList.add('cache'); $('lienOubli').classList.remove('cache');
      ['oubliSecours', 'oubliPin', 'oubliPin2'].forEach(id => { $(id).value = ''; });
      message('✅ Nouveau code enregistré.');
      $('v-pin').classList.add('cache'); $('chargement').classList.remove('cache');
      charger();
    })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { b.disabled = false; });
}
function validerPin() {
  PIN = $('pin').value.trim();
  $('v-pin').classList.add('cache'); $('chargement').classList.remove('cache');
  charger();
}

function charger() {
  if (!API) {
    const c = $('chargement'); c.textContent = "🔗 Ouvre l'application avec le lien de ton salon.";
    const p = el('p', '', "Pas encore d'application ? "); const l = el('a', '', 'Crée la tienne gratuitement'); l.href = 'inscription.html'; l.style.color = 'var(--rose)';
    p.appendChild(l); c.appendChild(p);
    return;
  }
  if (RESET && SALON && !resetTraite) return afficherResetEmail();
  if (!PIN) return demanderPin();
  // Ouverture instantanée : on affiche tout de suite les données gardées sur le téléphone,
  // puis on les remplace par celles du Google Sheet dès qu'elles arrivent.
  let dejaAffiche = false;
  const memo = lsGet(CLE_DONNEES);
  if (memo && !initFait) {
    try { D = JSON.parse(memo); $('chargement').classList.add('cache'); init(); dejaAffiche = true; majBandeauSync(true); } catch (e) { D = null; }
  }
  api('donnees').then(j => {
    lsSet(CLE_PIN, PIN);
    horsLigne = false; majBandeauSync(false);
    if (dejaAffiche) majTout(j.data);
    else { D = j.data; lsSet(CLE_DONNEES, JSON.stringify(D)); $('chargement').classList.add('cache'); init(); }
    envoyerAttente();
    if (RETOUR_PAIEMENT && !paiementVerifie) { paiementVerifie = true; verifierPaiement(true); }
  }).catch(e => {
    majBandeauSync(false);
    if (e.message === 'PIN' || /essais/.test(e.message)) {
      if (dejaAffiche) { Object.keys(ONGLET_DE).forEach(x => $('v-' + x).classList.add('cache')); D = null; initFait = false; }
      if (e.message === 'PIN') { lsDel(CLE_PIN); PIN = ''; return demanderPin('❌ Code incorrect, réessaie.'); }
      return demanderPin('⛔ ' + e.message);
    }
    if (dejaAffiche) { if (e.horsLigne) { horsLigne = true; majBandeau(); } else erreur(e); return; }
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
  // Logo (ou icône du métier) en grand à gauche, nom de l'activité bien visible
  const l = $('logoEntete'); l.textContent = ''; l.classList.remove('cache');
  const emoji = () => { l.textContent = icone(); l.classList.add('logo-emoji'); };
  if (P().logo) { l.classList.remove('logo-emoji'); const img = el('img'); img.src = P().logo; img.alt = ''; img.onerror = () => { img.remove(); emoji(); }; l.appendChild(img); }
  else emoji();
  $('titre').textContent = D.reglages.nomSalon;
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
    document.querySelectorAll('#periodesStats .puce').forEach(b => b.onclick = () => {
      periodeStats = b.dataset.p;
      document.querySelectorAll('#periodesStats .puce').forEach(x => x.classList.toggle('on', x === b));
      afficherStats();
    });
    initFait = true;
  }
  construirePrestations();
  construirePaiements($('choixPaiement'), m => { paiementChoisi = m; });
  nouvelleSaisie();
  initAchats();
  rafraichir();
  vue('accueil');
  setTimeout(() => lancerVisite(), 700);
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
  if (vueActive === 'accueil') afficherAccueil();
  afficherClientes(); afficherBilan(); afficherTarifs(); afficherOffres(); afficherAchats(); remplirNoms();
  if (vueActive === 'recettes') afficherRecettes();
  if (vueActive === 'stats') afficherStats();
  if (vueActive === 'agenda') afficherAgenda();
}

/* Écrans et onglet du bas correspondant (les sous-écrans allument leur onglet parent) */
const ONGLET_DE = { accueil: 'accueil', agenda: 'agenda', nouvelle: 'nouvelle', clientes: 'clientes', fiche: 'clientes', bilan: 'bilan', plus: '', reglages: '', import: '', abonnement: '', tarifs: '', offres: '', achats: '', recettes: 'bilan', stats: 'bilan' };
function vue(v) {
  const avant = vueActive;
  vueActive = v;
  fermerGlisses();
  Object.keys(ONGLET_DE).forEach(x => $('v-' + x).classList.toggle('cache', x !== v));
  animerEcran($('v-' + v), sensTransition(avant, v));
  if (v !== 'accueil') videRecherche();
  ['accueil', 'agenda', 'clientes', 'nouvelle', 'bilan'].forEach(x => $('t-' + x).classList.toggle('actif', ONGLET_DE[v] === x));
  document.body.classList.toggle('en-saisie', v === 'nouvelle' && !$('formulaire').classList.contains('cache'));
  if (v === 'tarifs') { afficherTarifs(); lsSet(cleBienvenue('tarifs'), '1'); }
  if (v === 'accueil') afficherAccueil();
  if (v === 'recettes') afficherRecettes();
  if (v === 'agenda') afficherAgenda();
  if (v === 'reglages') afficherReglagesEcran();
  if (v === 'abonnement') afficherAbonnement();
  if (v === 'import') { $('importApercu').innerHTML = ''; const ok = 'contacts' in navigator && 'ContactsManager' in window; $('btnContacts').classList.toggle('cache', !ok); $('contactsIndispo').classList.toggle('cache', ok); }
  if (v === 'stats') afficherStats();
  window.scrollTo(0, 0);
}

/** Bouton + du bas : ouvre une saisie (neuve si la précédente vient d'être enregistrée). */
function ouvrirSaisie() {
  if (abonnementBloque()) return afficherPaywall();
  if (!$('succes').classList.contains('cache')) nouvelleSaisie();
  vue('nouvelle');
}

/** Accueil : prestations du jour + carte du salon (écran Plus). */
/* Carte « Bienvenue » : 3 premiers pas pour une nouvelle inscrite, puis elle disparaît */
const cleBienvenue = k => 'bienvenue_' + k + '_' + (SALON || 'api');
function afficherBienvenue() {
  const z = $('bienvenue'); z.innerHTML = '';
  const etapes = [
    { fait: !!lsGet(cleBienvenue('tarifs')) || D.journal.length > 0, txt: 'Vérifie tes prestations et tes prix', action: () => vue('tarifs') },
    { fait: !!P().logo, txt: 'Ajoute ton logo', action: () => vue('reglages') },
    { fait: D.journal.length > 0, txt: 'Enregistre ta première prestation', action: () => ouvrirSaisie() },
  ];
  const restantes = etapes.filter(e => !e.fait).length;
  if (!restantes || lsGet(cleBienvenue('masquee'))) return;
  const k = el('div', 'carte bienvenue');
  const l1 = el('div', 'ligne1'); l1.appendChild(avecIco(el('span', 'titre-ico', 'Bienvenue !'), 'etincelles')); l1.appendChild(el('span', 'badge', (3 - restantes) + '/3'));
  k.appendChild(l1);
  k.appendChild(el('div', 'ligne2', 'Trois petits pas pour bien démarrer :'));
  etapes.forEach(e => {
    const b = el('button', 'etape-bienvenue' + (e.fait ? ' faite' : ''));
    b.appendChild(el('span', 'coche', e.fait ? '✓' : ''));
    b.appendChild(el('span', '', e.txt));
    if (!e.fait) { b.appendChild(el('span', 'chevron', '›')); b.onclick = e.action; }
    k.appendChild(b);
  });
  const m = el('button', 'lien', 'Masquer'); m.onclick = () => { lsSet(cleBienvenue('masquee'), '1'); afficherBienvenue(); };
  k.appendChild(m);
  z.appendChild(k);
}

function afficherAccueil() {
  if (!D) return;
  afficherCarteAbo();
  afficherBienvenue();
  afficherRdvAccueil();
  const z = $('journee'); z.innerHTML = '';
  const jour = D.journal.filter(r => r.iso === D.aujourdHuiIso).reverse();
  if (!jour.length) z.appendChild(el('p', 'discret', 'Aucune prestation enregistrée aujourd\'hui.'));
  jour.forEach(r => z.appendChild(carteSaisie(r, true)));
  const info = $('infoSalon'); info.innerHTML = '';
  const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', icone() + ' ' + ((D.reglages && D.reglages.nomSalon) || 'Mon salon')));
  info.appendChild(l1);
  info.appendChild(el('div', 'ligne2', [D.reglages && D.reglages.metier, D.clientes.length + ' ' + M('cliente', 'client') + (D.clientes.length > 1 ? 's' : ''),
    D.journal.length + ' prestation' + (D.journal.length > 1 ? 's' : '') + ' enregistrée' + (D.journal.length > 1 ? 's' : '')].filter(Boolean).join(' · ')));
  $('lienRecommander').href = lienSms('', 'Je te conseille cette application gratuite pour suivre tes clients (fidélité automatique, agenda, rappels SMS, bilan) : ' + location.origin + location.pathname.replace(/[^/]*$/, '') + 'inscription.html');
}

/** Plus → Verrouiller : oublie le code sur cet appareil. */
function verrouiller() {
  if (!confirm('Verrouiller l\'application sur cet appareil ? Le code sera redemandé.')) return;
  lsDel(CLE_PIN); location.reload();
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
  rdvEnCours = null;
  cliente = null; choisis = []; prixManuel = false; offreChoisie = null; paiementChoisi = null;
  $('recherche').value = ''; $('prix').value = '';
  $('prixAuto').classList.add('cache');
  $('clienteChoisie').classList.add('cache'); $('clienteRecherche').classList.remove('cache');
  $('dejaFait').innerHTML = '';
  $('formulaire').classList.remove('cache'); $('succes').classList.add('cache');
  document.body.classList.toggle('en-saisie', vueActive === 'nouvelle');
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
  b.appendChild(avatar(c.nom));
  b.appendChild(el('span', 'choix-nom', c.nom));
  b.appendChild(el('small', '', infoCliente(c)));
  b.onclick = () => choisirCliente(c);
  return b;
}

function choisirCliente(c) {
  cliente = c;
  $('clienteNom').textContent = c.nom;
  $('clienteChoisie').classList.remove('cache'); $('clienteRecherche').classList.add('cache');
  afficherDejaFait();
  majResume();
}
function changerCliente() { $('dejaFait').innerHTML = ''; cliente = null; $('clienteChoisie').classList.add('cache'); $('clienteRecherche').classList.remove('cache'); $('recherche').focus(); majResume(); }

function construirePrestations(garderChoix) {
  const zP = $('prestations'), zO = $('options'); zP.innerHTML = ''; zO.innerHTML = '';
  if (!garderChoix) choisis = [];
  tarifsTries().forEach(t => {
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
    const b = avecIco(el('button', 'puce', m), ICO_PAIEMENT[m] || 'inconnu'); b.dataset.mode = m;
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
  $('encaisser').textContent = euros(prix || choisis.length ? aPayer : 0) + (offreChoisie && !offre && prix ? ' · ' + offreChoisie.nom : '');
  return aPayer;
}

function enregistrer() {
  if (abonnementBloque()) return afficherPaywall();
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
  // Confirmation immédiate : la saisie part dans la file d'envoi (gardée sur le téléphone jusqu'à l'envoi),
  // le Google Sheet est mis à jour en arrière-plan, sans doublon possible (identifiant unique).
  const fidelite = offreProchaine();
  const detail = fidelite ? '🎁 Passage fidélité : ' + RED() + ' appliqué !'
    : p.offre ? '🏷️ Offre appliquée : ' + p.offre.nom + ' ' + texteOffre(p.offre)
    : (GENERIQUES.includes(cliente.cle) ? '' : ((cliente.total || 0) + 1) + 'e passage au total.');
  mettreEnAttente(item);
  if (rdvEnCours) { const id = rdvEnCours; rdvEnCours = null; envoyerRdv({ id, statut: 'fait' }); }
  majLocaleApresSaisie(cliente, p.date);
  dernierPassageOffert = !!fidelite;
  afficherSucces(horsLigne ? '!' : '✓', horsLigne ? 'Gardé sur le téléphone' : 'Enregistré pour ' + p.client,
    horsLigne ? 'Pas d\'internet : la saisie sera envoyée automatiquement dès le retour du réseau.' : detail, aPayer);
  vibrer([14, 60, 22]);
  envoyerAttente();
}

/** Met à jour tout de suite les compteurs du client sur le téléphone (avant la réponse du Google Sheet). */
function majLocaleApresSaisie(c, iso) {
  if (GENERIQUES.includes(c.cle)) return;
  const compte = iso >= D.debutOffreIso;
  const fr = iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  let x = D.clientes.find(y => y.cle === c.cle);
  if (!x) { x = { cle: c.cle, nom: c.nom, total: 0, depuis: 0, ca: 0, derniere: '', anniversaire: '', nomFamille: '', tel: '', notes: '' }; D.clientes.push(x); }
  x.total++; if (compte) x.depuis++;
  if (!x.derniere || dateNum(fr) >= dateNum(x.derniere)) x.derniere = fr;
}

let dernierPassageOffert = false;
function afficherSucces(icone, titre, detail, montant) {
  document.body.classList.remove('en-saisie');
  const bA = $('succesAvis');
  const c = cliente && D.clientes.find(x => x.cle === cliente.cle);
  bA.classList.toggle('cache', !P().avis || !cliente);
  const bM = $('succesMerci');
  bM.classList.toggle('cache', !c || GENERIQUES.includes(c.cle));
  if (c) bM.href = lienSms(c.tel, texteMerci(c, dernierPassageOffert));
  if (P().avis && cliente) bA.href = lienSms(c && c.tel, texteAvis(cliente.nom));
  $('formulaire').classList.add('cache'); $('succes').classList.remove('cache');
  $('succesIcone').textContent = icone; $('succesTitre').textContent = titre; $('succesDetail').textContent = detail;
  $('succesMontant').textContent = 'À encaisser : ' + euros(montant) + (paiementChoisi && mod('paiement') ? ' · ' + paiementChoisi : '');
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
/** Fidélité avant un rendez-vous : le passage à venir est-il le passage récompensé ? */
function phraseFideliteAvant(c, iso) {
  if (!c || GENERIQUES.includes(c.cle) || !fideliteActive() || (iso && iso < D.debutOffreIso)) return '';
  const P = D.passagesPourOffre, n = c.depuis % P;
  if (n === P - 1) return ' Bonne nouvelle : ce passage est votre ' + P + 'e, il sera à ' + RED() + ' sur la prestation la plus chère 🎁';
  return ' Votre fidélité : ' + n + '/' + P + ', encore ' + (P - n) + ' passage' + (P - n > 1 ? 's' : '') + ' avant ' + RED() + '.';
}
/** Fidélité juste après un passage (compteur déjà mis à jour). */
function phraseFideliteApres(c, offerte) {
  if (!c || GENERIQUES.includes(c.cle) || !fideliteActive()) return '';
  const P = D.passagesPourOffre, n = c.depuis % P;
  if (offerte) return ' Votre réduction fidélité de ' + RED() + ' a été appliquée aujourd\'hui 🎁 Votre carte repart à zéro.';
  if (n === P - 1) return ' Fidélité : ' + n + '/' + P + ', votre prochain passage sera à ' + RED() + ' 🎁';
  return ' Fidélité : ' + n + '/' + P + ', encore ' + (P - n) + ' passage' + (P - n > 1 ? 's' : '') + ' avant ' + RED() + '.';
}
/** Prénom seul pour les SMS (« Julie Martin » → « Julie »). */
const prenom = n => String(n || '').trim().split(' ')[0];
const texteMerci = (c, offerte) => 'Merci ' + prenom(c.nom) + ' pour votre visite chez ' + nomSalon() + ' !' + phraseFideliteApres(c, offerte) + ' À bientôt 😊';
const texteAvis = nom => 'Bonjour ' + prenom(nom) + ', merci pour votre visite chez ' + nomSalon() + ' ! Si vous avez une minute, votre avis nous aiderait beaucoup : ' + P().avis;
const texteRelance = nom => 'Bonjour ' + prenom(nom) + ', cela fait un moment ! Au plaisir de vous revoir chez ' + nomSalon() + '. Répondez à ce message pour prendre rendez-vous 😊';

function appliquerReglages() {
  const ab = D && D.abonnement;
  $('menuAbo').classList.toggle('cache', !ab || ab.statut === 'gratuit');
  ['fidelite', 'offres', 'options', 'paiement', 'achats', 'fiche', 'heure']
    .forEach(k => document.body.classList.toggle('sans-' + k, !mod(k)));
  document.querySelectorAll('[data-mot]').forEach(e => { const [f, m] = e.dataset.mot.split('|'); e.textContent = estClient() ? m : f; });
  $('titrePrestations').textContent = icone() + ' Prestations';
  $('iconeClients').textContent = iconeClients();
  $('ficheNotes').placeholder = (D.reglages && D.reglages.notes) || 'Préférences, allergies, remarques…';
  appliquerTheme();
  const j = P().relance || 60;
  const fAbs = document.querySelector('[data-f="absente"]');
  fAbs.textContent = M('Pas venue depuis ', 'Pas venu depuis ') + j + ' jours';
  $('recherche').placeholder = 'Tape le prénom…';
  $('rechercheGlobale').placeholder = M('Rechercher une cliente, une prestation…', 'Rechercher un client, une prestation…');
  if (!mod('achats') && vueActive === 'achats') vue('plus');
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
    const k = el('div', 'carte cliquable client-carte');
    k.appendChild(avatar(c.nom));
    const corps = el('div', 'client-corps'); k.appendChild(corps);
    const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', c.nom));
    if (prochesOffre(c)) l1.appendChild(el('span', 'badge', '🎁 ' + RED() + ' au prochain'));
    else l1.appendChild(el('span', 'chevron', '›'));
    corps.appendChild(l1);
    const infos = [c.total + ' passage' + (c.total > 1 ? 's' : '')];
    if (c.derniere) infos.push('vue le ' + c.derniere);
    if (c.anniversaire) infos.push('🎂 ' + c.anniversaire);
    if (c.ca) infos.push(euros(c.ca));
    corps.appendChild(el('div', 'ligne2', infos.join(' · ')));
    if (fideliteActive()) corps.appendChild(pointsFidelite(c));
    k.onclick = () => ouvrirFiche(c.cle);
    const tel = String(c.tel || '').replace(/[^0-9+]/g, '');
    const gauche = tel.length >= 6 ? [
      { txt: 'Appeler', ico: 'tel', href: 'tel:' + tel, cls: 'appel' },
      { txt: 'SMS', ico: 'message', href: 'sms:' + tel + '?&body=' + encodeURIComponent('Bonjour ' + prenom(c.nom) + ', ') },
    ] : [];
    box.appendChild(glissable(k, gauche, { txt: 'Nouvelle prestation', ico: 'plus', action: () => prestationPour(c) }));
  });
}

/* ======================= FICHE CLIENTE ======================= */
let ficheCle = null;

function ouvrirFiche(cle, rafraichissement) {
  const c = D.clientes.find(x => x.cle === cle);
  if (!c) { if (!rafraichissement) message('Cliente introuvable.'); return vue('clientes'); }
  ficheCle = cle;
  const fe = document.querySelector('.fiche-entete'), avAncien = fe.querySelector('.avatar');
  if (avAncien) avAncien.remove();
  fe.insertBefore(avatar(c.nom, true), fe.firstChild);
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
  if (c.total > lignes.length) boutonAnneesPrecedentes(h, () => ouvrirFiche(cle, true));
  if (!rafraichissement) vue('fiche');
}

function majContact() {
  const tel = $('ficheTel').value.replace(/[^\d+]/g, '');
  // Appeler / SMS seulement avec un numéro ; Avis et Relancer restent disponibles (SMS sans destinataire)
  $('ficheAppel').classList.toggle('cache', tel.length < 6);
  $('ficheSms').classList.toggle('cache', tel.length < 6);
  $('ficheAppel').href = 'tel:' + tel;
  const c = D.clientes.find(x => x.cle === ficheCle);
  $('ficheSms').href = 'sms:' + tel + '?&body=' + encodeURIComponent('Bonjour ' + (c ? prenom(c.nom) : '') + ', ');
  $('ficheRelance').classList.toggle('cache', !(c && absente(c)));
  if (c) $('ficheRelance').href = lienSms(tel, texteRelance(c.nom));
  $('ficheAvis').classList.toggle('cache', !P().avis);
  // Carte de fidélité de la personne (lien personnel, sans code)
  const lien = c && c.jeton && SALON ? location.origin + location.pathname.replace(/[^/]*$/, '') + 'carte.html?s=' + SALON + '&c=' + encodeURIComponent(c.cle) + '&j=' + c.jeton : '';
  $('ficheCarte').classList.toggle('cache', !lien || GENERIQUES.includes(ficheCle));
  $('ficheCarteVoir').classList.toggle('cache', !lien || GENERIQUES.includes(ficheCle));
  if (lien) {
    $('ficheCarte').href = lienSms(tel, 'Bonjour ' + prenom(c.nom) + ', voici votre carte de fidélité ' + nomSalon() + ' : ' + lien + ' (elle se met à jour à chaque passage).');
    $('ficheCarteVoir').href = lien;
  }
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
  if (r.paiement) det.push(r.paiement);
  k.appendChild(el('div', 'ligne2', det.join(' · ')));
  const b = avecIco(el('button', 'lien', 'Modifier'), 'crayon');
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
  if (abonnementBloque()) return afficherPaywall();
  const r = enEdition, i = D.journal.indexOf(r);
  fermerModale();
  actionAnnulable('Saisie de ' + r.client + ' supprimée',
    () => { D.journal = D.journal.filter(x => x !== r); rafraichirApresLocal(); },
    () => { mettreEnAttente({ action: 'supprimer', uid: uid(), extra: { id: r.id }, resume: 'suppression ' + r.client }); envoyerAttente(); },
    () => { D.journal.splice(Math.max(0, i), 0, r); rafraichirApresLocal(); });
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
      const prix = el('input'); prix.type = 'number'; prix.inputMode = 'decimal'; prix.value = t.prix; prix.className = 'prix-tarif'; prix.setAttribute('aria-label', 'Prix');
      const duree = el('input'); duree.type = 'number'; duree.inputMode = 'numeric'; duree.value = t.duree || ''; duree.className = 'duree-tarif';
      duree.placeholder = 'min'; duree.setAttribute('aria-label', 'Durée en minutes');
      const taux = el('div', 'taux-tarif');
      const majTaux = () => { taux.textContent = t.duree > 0 && t.prix > 0 ? '≈ ' + euros(t.prix / t.duree * 60) + ' de l\'heure' : (opt ? '' : 'Ajoute la durée pour voir le taux horaire'); };
      prix.oninput = () => { t.prix = nombre(prix.value) || 0; majTaux(); };
      duree.oninput = () => { t.duree = parseInt(duree.value, 10) || 0; majTaux(); };
      const sup = el('button', 'supprimer', '✕'); sup.title = 'Retirer';
      sup.onclick = () => { tarifsEdition.splice(i, 1); dessinerTarifs(); };
      ligne.appendChild(nom); ligne.appendChild(prix); ligne.appendChild(el('span', 'euro', '€')); ligne.appendChild(duree); ligne.appendChild(el('span', 'euro', 'min')); ligne.appendChild(sup);
      z.appendChild(ligne); z.appendChild(taux); majTaux();
    });
  });
}
function ajouterLigneTarif(option) {
  tarifsEdition.push({ nom: '', prix: 0, option, duree: 0 });
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

  // Règles de la fidélité, modifiables depuis l'application
  const f = el('div', 'carte');
  f.appendChild(el('div', 'ligne1', 'Règles de la fidélité'));
  const champ = (label, id, type, valeur, attrs) => {
    const l = el('label', 'etiquette', label); l.htmlFor = id; f.appendChild(l);
    const i = el('input'); i.type = type; i.id = id; i.value = valeur;
    Object.assign(i, attrs || {}); f.appendChild(i); return i;
  };
  const grille = el('div', 'quand');
  const bloc1 = el('div'), bloc2 = el('div');
  grille.appendChild(bloc1); grille.appendChild(bloc2);
  const lab = (parent, txt, id) => { const l = el('label', 'etiquette', txt); l.htmlFor = id; parent.appendChild(l); };
  lab(bloc1, 'Réduction (%)', 'fidReduction');
  const iRed = el('input'); iRed.type = 'number'; iRed.id = 'fidReduction'; iRed.inputMode = 'decimal'; iRed.min = 1; iRed.max = 100; iRed.value = D.reductionFidelite || 50; bloc1.appendChild(iRed);
  lab(bloc2, 'Tous les … passages', 'fidPassages');
  const iPas = el('input'); iPas.type = 'number'; iPas.id = 'fidPassages'; iPas.inputMode = 'numeric'; iPas.min = 2; iPas.max = 50; iPas.value = D.passagesPourOffre; bloc2.appendChild(iPas);
  f.appendChild(grille);
  champ('Compter les passages à partir du', 'fidDebut', 'date', D.debutOffreIso);
  f.appendChild(el('div', 'ligne2', 'La réduction porte sur la prestation la plus chère. Les nouvelles règles s\'appliquent aussi aux passages déjà enregistrés depuis la date de début.'));
  const bOk = el('button', 'gros secondaire', 'Enregistrer les règles'); bOk.id = 'btnFidRegles';
  bOk.onclick = sauverReglesFidelite;
  f.appendChild(bOk);
  z.appendChild(f);
}

function sauverReglesFidelite() {
  const r = { reduction: nombre($('fidReduction').value), passages: parseInt($('fidPassages').value, 10), debut: $('fidDebut').value };
  if (!(r.reduction > 0 && r.reduction <= 100)) return message('👉 Réduction entre 1 et 100 %.');
  if (!(r.passages >= 2 && r.passages <= 50)) return message('👉 Nombre de passages entre 2 et 50.');
  if (!confirm('Appliquer : ' + r.reduction + ' % au ' + r.passages + 'e passage, en comptant depuis le ' + r.debut.split('-').reverse().join('/') + ' ?\n\nLes passages fidélité déjà enregistrés depuis cette date seront recalculés.')) return;
  $('btnFidRegles').disabled = true;
  api('fidelite_regles', { r }).then(j => { majTout(j.data); message('✅ Règles de fidélité enregistrées.'); })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { const b = $('btnFidRegles'); if (b) b.disabled = false; });
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
    if (!liste.length) return; // rien à surveiller : pas de carte vide
    const k = el('div', 'carte');
    k.appendChild(el('div', 'ligne1', titre + ' (' + liste.length + ')'));
    const l = el('div', 'liens-clientes');
    liste.forEach(c => { const b = el('button', 'puce', detail(c)); b.onclick = () => ouvrirFiche(c.cle); l.appendChild(b); });
    k.appendChild(l);
    sv.appendChild(k);
  };
  bloc('🎁 ' + RED() + ' à leur prochaine visite', D.clientes.filter(prochesOffre), c => c.nom);
  bloc('🎂 Anniversaire ce mois-ci', D.clientes.filter(anniversaireCeMois), c => c.nom + ' (' + c.anniversaire + ')');
  bloc('💤 À relancer (plus de ' + (P().relance || 60) + ' jours)', D.clientes.filter(absente), c => c.nom + ' (' + c.derniere + ')');
  $('titreSurveiller').classList.toggle('cache', !sv.children.length);
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
  if (abonnementBloque()) return afficherPaywall();
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
    const b = avecIco(el('button', 'lien danger', 'Supprimer'), 'poubelle');
    b.onclick = () => {
      if (abonnementBloque()) return afficherPaywall();
      const i = D.achats.indexOf(a);
      actionAnnulable('Achat « ' + a.libelle + ' » supprimé',
        () => { D.achats = D.achats.filter(x => x !== a); afficherAchats(); },
        () => api('achat_supprimer', { row: a.row }).then(j => majTout(j.data))
          .catch(e => { erreur(e.horsLigne ? 'Pas d\'internet : l\'achat n\'a pas été supprimé, réessaie.' : e); rafraichir(); }),
        () => { D.achats.splice(Math.max(0, i), 0, a); afficherAchats(); });
    };
    k.appendChild(b);
    box.appendChild(k);
  });
}

/* ======================= BILAN ======================= */
function barres(zone, valeurs, icone, vide, format, garderOrdre) {
  zone.innerHTML = '';
  const cles = Object.keys(valeurs).filter(k => valeurs[k]);
  if (!garderOrdre) cles.sort((a, b) => valeurs[b] - valeurs[a]);
  const total = cles.reduce((s, k) => s + valeurs[k], 0), max = cles.reduce((m, k) => Math.max(m, valeurs[k]), 0);
  if (!cles.length) zone.appendChild(el('div', 'ligne2', vide));
  cles.forEach(c => {
    const v = valeurs[c], k = el('div', 'cat');
    const l = el('div', 'ligne1'); l.appendChild(el('span', '', (icone(c) ? icone(c) + ' ' : '') + c)); l.appendChild(el('span', '', (format ? format(v) : euros(v)) + ' · ' + Math.round(v / total * 100) + ' %'));
    k.appendChild(l);
    const b = el('div', 'barre'); b.style.width = Math.max(4, v / max * 100) + '%'; k.appendChild(b);
    zone.appendChild(k);
  });
}

function afficherBilan() {
  $('jourSous').textContent = D.jour.nb + ' prestation' + (D.jour.nb > 1 ? 's' : '');
  $('jourCa').textContent = euros(D.jour.ca);
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

  barres($('paiements'), D.parPaiement, () => '', 'Aucun encaissement cette année.');
  barres($('categories'), D.parCategorie, iconeCat, 'Aucun achat enregistré cette année. Ajoute-les dans l\'onglet 🧾 Achats.');

  const lignesAn = D.journal.filter(r => anneeDe(r) === D.annee);
  const payees = lignesAn.filter(r => typeof r.caApres === 'number');
  $('anNb').textContent = lignesAn.length;
  $('anPanier').textContent = payees.length ? euros(payees.reduce((s, r) => s + r.caApres, 0) / payees.length) : '–';
  const th = tauxHoraire(lignesAn);
  $('anTaux').textContent = th.nb ? euros(th.taux) + ' / h' : '–';
  $('anTauxDetail').textContent = th.nb
    ? 'Calculé sur ' + th.nb + ' prestation' + (th.nb > 1 ? 's' : '') + ' (' + String(Math.round(th.heures * 10) / 10).replace('.', ',') + ' h de travail), d\'après les durées de tes tarifs.'
    : 'Ajoute la durée de tes prestations (Plus → Tarifs) pour connaître ton vrai taux horaire.';
  graphiqueMois();
  afficherHistorique();
}

/* ======================= DURÉE ET TAUX HORAIRE ======================= */
/** Durée totale (min) d'une saisie « A + B » d'après les tarifs ; 0 si une durée manque. */
function dureeDe(prestation) {
  const parNom = {}; (D.tarifs || []).forEach(t => { parNom[t.nom] = t.duree || 0; });
  let total = 0;
  for (const n of String(prestation || '').split(' + ').map(x => x.trim()).filter(Boolean)) {
    if (n === 'Déplacement') continue;
    if (!parNom[n]) return 0;
    total += parNom[n];
  }
  return total;
}
/** Taux horaire moyen sur une liste de saisies (seulement celles dont la durée est connue). */
function tauxHoraire(lignes) {
  let ca = 0, min = 0, nb = 0;
  lignes.forEach(r => { const d = dureeDe(r.prestation); if (d && typeof r.caApres === 'number') { ca += r.caApres; min += d; nb++; } });
  return { taux: min ? ca / min * 60 : 0, heures: min / 60, nb };
}

/* ======================= CHIFFRES CALCULÉS DEPUIS L'HISTORIQUE ======================= */
const montant = r => typeof r.caApres === 'number' ? r.caApres : 0;
const anneeDe = r => Number(String(r.iso).slice(0, 4));
const moisDe = r => Number(String(r.iso).slice(5, 7)) - 1;
const cleTri = r => r.iso + ' ' + (heureVersChamp(r.heure) || '00:00') + ' ' + String(r.id).replace(/\d+/g, n => n.padStart(6, '0'));
const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const signe = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' %';

/** CA et nombre de prestations par mois pour une année (jusqu'au jour « mm-jj » inclus si donné). */
function parMois(annee, jusquA) {
  const m = Array.from({ length: 12 }, () => ({ ca: 0, nb: 0, payees: 0 }));
  D.journal.forEach(r => {
    if (anneeDe(r) !== annee || (jusquA && r.iso.slice(5) > jusquA)) return;
    const x = m[moisDe(r)]; x.ca += montant(r); x.nb++; if (typeof r.caApres === 'number') x.payees++;
  });
  return m;
}

/* Graphique : barres par mois, année en cours (couleur du salon) et année précédente (gris) */
let moisGraph = null;
function graduation(max) {
  const brut = max / 3, p = Math.pow(10, Math.floor(Math.log10(brut || 1)));
  const pas = [1, 2, 2.5, 5, 10].map(k => k * p).find(k => k >= brut) || 10 * p;
  return { pas, haut: Math.max(pas, Math.ceil(max / pas) * pas) };
}
const eurosCourt = v => v >= 1000 ? (Math.round(v / 100) / 10).toLocaleString('fr-FR') + ' k€' : Math.round(v) + ' €';
function graphiqueMois() {
  const an = D.annee, cur = parMois(an), prec = parMois(an - 1);
  const aPrec = prec.some(m => m.nb);
  if (moisGraph === null) moisGraph = new Date().getMonth();
  const W = 340, H = 168, G = 40, B = 22, T = 8, NS = 'http://www.w3.org/2000/svg';
  const max = Math.max(1, ...cur.map(m => m.ca), ...(aPrec ? prec.map(m => m.ca) : [0]));
  const { pas, haut } = graduation(max);
  const y = v => T + (H - T - B) * (1 - v / haut);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Encaissé par mois en ' + an + (aPrec ? ', comparé à ' + (an - 1) : ''));
  const add = (tag, attrs, txt) => {
    const e = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k]));
    if (txt !== undefined) e.textContent = txt;
    svg.appendChild(e); return e;
  };
  const slot = (W - G) / 12;
  add('rect', { class: 'g-bande', x: G + moisGraph * slot + 1, y: T - 4, width: slot - 2, height: H - T - B + 8, rx: 6 });
  for (let v = 0; v <= haut + 1e-9; v += pas) {
    add('line', { class: 'g-grille', x1: G, x2: W, y1: y(v), y2: y(v) });
    add('text', { class: 'g-txt', x: G - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, eurosCourt(v));
  }
  // Barre arrondie en haut seulement, posée sur la ligne du zéro
  const barre = (x, w, v, cls) => {
    if (!v) return;
    const h = Math.max(2, y(0) - y(v)), r = Math.min(4, w / 2, h), yt = y(0) - h;
    add('path', { class: cls, d: 'M' + x + ',' + y(0) + 'V' + (yt + r) + 'Q' + x + ',' + yt + ' ' + (x + r) + ',' + yt +
      'H' + (x + w - r) + 'Q' + (x + w) + ',' + yt + ' ' + (x + w) + ',' + (yt + r) + 'V' + y(0) + 'Z' });
  };
  const bw = aPrec ? Math.min(10, (slot - 8) / 2) : Math.min(16, slot - 8);
  for (let i = 0; i < 12; i++) {
    const cx = G + i * slot + slot / 2;
    if (aPrec) { barre(cx - bw - 1, bw, prec[i].ca, 'g-prec'); barre(cx + 1, bw, cur[i].ca, 'g-cur'); }
    else barre(cx - bw / 2, bw, cur[i].ca, 'g-cur');
    add('text', { class: 'g-txt' + (i === moisGraph ? ' on' : ''), x: cx, y: H - 6, 'text-anchor': 'middle' }, MOIS[i][0]);
    const cible = add('rect', { class: 'g-cible', x: G + i * slot, y: 0, width: slot, height: H });
    cible.addEventListener('click', () => { moisGraph = i; graphiqueMois(); });
    cible.addEventListener('mouseenter', () => { if (matchMedia('(hover: hover)').matches && moisGraph !== i) { moisGraph = i; graphiqueMois(); } });
  }
  const z = $('graphMois'); z.innerHTML = ''; z.appendChild(svg);

  const lg = $('graphLegende'); lg.innerHTML = '';
  if (aPrec) [[an, 'var(--rose)'], [an - 1, 'var(--annee-prec)']].forEach(([a, c]) => {
    const sp = el('span'), i = el('i'); i.style.background = c; sp.appendChild(i); sp.appendChild(document.createTextNode(a)); lg.appendChild(sp);
  });
  const m = cur[moisGraph], p = prec[moisGraph], d = $('graphDetail'); d.innerHTML = '';
  const l1 = el('div'); l1.appendChild(el('b', '', MOIS[moisGraph] + ' ' + an + ' : ' + euros(m.ca)));
  l1.appendChild(document.createTextNode(' · ' + m.nb + ' prestation' + (m.nb > 1 ? 's' : '') + (m.payees ? ' · panier moyen ' + euros(m.ca / m.payees) : '')));
  d.appendChild(l1);
  if (aPrec) {
    const e = pct(m.ca, p.ca);
    d.appendChild(el('div', '', MOIS[moisGraph] + ' ' + (an - 1) + ' : ' + euros(p.ca) + (e !== null && m.ca ? ' (' + signe(e) + ')' : '')));
  }
  const mmjj = D.aujourdHuiIso.slice(5);
  const tot = a => parMois(a, mmjj).reduce((s, x) => s + x.ca, 0);
  const t1 = tot(an), t0 = aPrec ? tot(an - 1) : 0, ev = pct(t1, t0);
  $('graphCompare').textContent = aPrec
    ? 'Depuis le 1er janvier : ' + euros(t1) + ' contre ' + euros(t0) + ' à la même date en ' + (an - 1) + (ev !== null ? ' (' + signe(ev) + ').' : '.')
    : 'Touche un mois pour voir son détail. La comparaison avec l\'année précédente apparaîtra quand il y aura des saisies sur deux années.';
}

/* ======================= JOURNAL COMPLET (années anciennes, à la demande) ======================= */
let chargementJournal = null;
/** Charge toutes les années (une seule fois) puis rappelle « ensuite ». */
function chargerJournalComplet(ensuite) {
  if (!D || !D.journalPartiel) { if (ensuite) ensuite(); return Promise.resolve(); }
  if (!chargementJournal) {
    message('⏳ Chargement des années précédentes…', 8000);
    chargementJournal = api('journal_complet')
      .then(j => { D.journal = j.data.journal; D.journalPartiel = false; D.journalCompletCharge = true; $('msg').style.display = 'none'; })
      .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : les années précédentes ne sont pas disponibles.' : e))
      .finally(() => { chargementJournal = null; });
  }
  return chargementJournal.then(() => { if (ensuite) ensuite(); });
}
const anneeDebutJournal = () => D && D.journalDepuisIso ? Number(D.journalDepuisIso.slice(0, 4)) : 0;
/** Bouton « Voir aussi avant 2025 » quand des années anciennes ne sont pas chargées. */
function boutonAnneesPrecedentes(zone, ensuite) {
  if (!D.journalPartiel) return;
  const b = el('button', 'lien', '📂 Voir aussi avant ' + anneeDebutJournal());
  b.onclick = () => chargerJournalComplet(ensuite);
  zone.appendChild(b);
}

/* ======================= HISTORIQUE (recherche) ======================= */
function afficherHistorique() {
  const q = norm($('rechercheHisto').value);
  const box = $('recentes'); box.innerHTML = '';
  let liste = D.journal.slice().sort((a, b) => cleTri(b).localeCompare(cleTri(a)));
  if (!q) {
    liste = liste.slice(0, 20);
    $('histoResume').textContent = liste.length ? 'Les ' + liste.length + ' dernières saisies. Cherche un nom, une prestation, une date (ex. 03/2026 ou mars 2026) ou un montant.' : '';
  } else {
    const num = /^\d+([.,]\d+)?$/.test(q) ? nombre(q) : null;
    liste = liste.filter(r => {
      if (num !== null && (Math.abs(montant(r) - num) < 0.005 || r.prix === num)) return true;
      return norm([r.client, r.date, r.prestation, r.libelle, r.paiement, MOIS[moisDe(r)] + ' ' + anneeDe(r)].join(' | ')).includes(q);
    });
    const total = liste.reduce((s, r) => s + montant(r), 0);
    $('histoResume').textContent = liste.length
      ? liste.length + ' saisie' + (liste.length > 1 ? 's' : '') + ' · ' + euros(total) + ' encaissé' + (liste.length > 60 ? ' · les 60 plus récentes affichées' : '')
      : 'Aucune saisie ne correspond.';
  }
  liste.slice(0, 60).forEach(r => box.appendChild(carteSaisie(r, true)));
  if (q) boutonAnneesPrecedentes(box, afficherHistorique);
}

/* ======================= LIVRE DES RECETTES ======================= */
function lignesRecettes() {
  const an = Number($('recAnnee').value), m = $('recMois').value;
  // N° de pièce : ordre chronologique dans l'année
  const annee = D.journal.filter(r => anneeDe(r) === an).sort((a, b) => cleTri(a).localeCompare(cleTri(b)));
  annee.forEach((r, i) => { r._num = an + '-' + String(i + 1).padStart(4, '0'); });
  return annee.filter(r => m === '' || moisDe(r) === Number(m));
}
const periodeRecettes = () => ($('recMois').value === '' ? 'année ' : MOIS[Number($('recMois').value)].toLowerCase() + ' ') + $('recAnnee').value;
function afficherRecettes() {
  const sa = $('recAnnee'), sm = $('recMois');
  const annees = Array.from(new Set(D.journal.map(anneeDe).concat(D.annees || [], [D.annee]))).sort((a, b) => b - a);
  const anAvant = sa.value, moisAvant = sm.value;
  sa.innerHTML = ''; annees.forEach(a => sa.appendChild(new Option(a, a)));
  sa.value = anAvant && annees.includes(Number(anAvant)) ? anAvant : String(D.annee);
  if (!sm.options.length) { sm.appendChild(new Option('Toute l\'année', '')); MOIS.forEach((n, i) => sm.appendChild(new Option(n, i))); }
  sm.value = moisAvant;
  if (D.journalPartiel && Number(sa.value) < anneeDebutJournal()) { $('tableRecettes').innerHTML = ''; return chargerJournalComplet(afficherRecettes); }
  const lignes = lignesRecettes();
  const total = lignes.reduce((s, r) => s + montant(r), 0);
  $('recTotal').textContent = euros(total); $('recNb').textContent = lignes.length;
  const tb = $('tableRecettes'); tb.innerHTML = '';
  if (!lignes.length) { const tr = el('tr'), td = el('td', '', 'Aucune recette sur cette période.'); td.colSpan = 6; tr.appendChild(td); tb.appendChild(tr); }
  lignes.forEach(r => {
    const tr = el('tr');
    tr.appendChild(el('td', '', r.date)); tr.appendChild(el('td', '', r._num)); tr.appendChild(el('td', '', r.client));
    tr.appendChild(el('td', '', r.prestation + (r.libelle ? ' (' + (r.fidelite ? 'fidélité ' : '') + r.libelle + ')' : '')));
    tr.appendChild(el('td', 'n', r.caApres !== null ? euros(r.caApres) : '–'));
    tr.appendChild(el('td', 'm-paiement', r.paiement || ''));
    tb.appendChild(tr);
  });
  const tr = el('tr', 'total-ligne'), td = el('td', '', 'Total ' + periodeRecettes()); td.colSpan = 4;
  tr.appendChild(td); tr.appendChild(el('td', 'n', euros(total))); tr.appendChild(el('td', 'm-paiement', '')); tb.appendChild(tr);
  const e = $('recEntete'); e.innerHTML = '';
  e.appendChild(el('h1', '', 'Livre des recettes – ' + periodeRecettes()));
  e.appendChild(el('p', '', [D.reglages && D.reglages.nomSalon, D.reglages && D.reglages.metier].filter(Boolean).join(' · ')));
  e.appendChild(el('p', '', 'Montants encaissés TTC, dans l\'ordre chronologique. Édité le ' + new Date().toLocaleDateString('fr-FR') + '.'));
}
function exporterRecettes() {
  const lignes = lignesRecettes();
  const champ = v => { const t = String(v === null || v === undefined ? '' : v); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const nombreFr = v => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
  const csv = [['Date', 'N° de pièce', M('Cliente', 'Client'), 'Nature de la prestation', 'Montant encaissé (€)', 'Mode de règlement', 'Réduction appliquée']]
    .concat(lignes.map(r => [r.date, r._num, r.client, r.prestation, r.caApres !== null ? nombreFr(r.caApres) : '', r.paiement || '', r.libelle || '']))
    .concat([['', '', '', 'TOTAL', nombreFr(lignes.reduce((s, r) => s + montant(r), 0)), '', '']])
    .map(l => l.map(champ).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'Livre des recettes - ' + periodeRecettes() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  message('📄 Fichier téléchargé : il s\'ouvre avec Excel, Numbers ou Google Sheets.');
}
function imprimerRecettes() { window.print(); }

/* ======================= STATISTIQUES CLIENTS ======================= */
let periodeStats = 'annee';
const JOURS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const jourMs = iso => new Date(iso + 'T12:00:00').getTime();
function afficherStats() {
  if (!D) return;
  if (periodeStats === 'tout' && D.journalPartiel) return chargerJournalComplet(afficherStats);
  const auj = jourMs(D.aujourdHuiIso);
  const dansPeriode = r => periodeStats === 'tout' ? true
    : periodeStats === 'annee' ? anneeDe(r) === D.annee
    : r.iso <= D.aujourdHuiIso && auj - jourMs(r.iso) < 365 * 864e5;
  const L = D.journal.filter(dansPeriode);
  const perso = L.filter(r => !GENERIQUES.includes(r.cle));

  // Première visite de chaque personne (sur tout l'historique)
  const premiere = {};
  D.journal.forEach(r => { if (!premiere[r.cle] || r.iso < premiere[r.cle]) premiere[r.cle] = r.iso; });
  const parCle = {};
  perso.forEach(r => { (parCle[r.cle] = parCle[r.cle] || []).push(r); });
  const cles = Object.keys(parCle);
  const nouvelles = cles.filter(k => parCle[k].some(r => r.iso === premiere[k])).length;
  const reviennent = cles.filter(k => parCle[k].length >= 2).length;
  // Rythme : écart médian (en jours) entre deux visites d'une même personne
  const ecarts = [];
  cles.forEach(k => {
    const jours = Array.from(new Set(parCle[k].map(r => r.iso))).sort();
    for (let i = 1; i < jours.length; i++) ecarts.push(Math.round((jourMs(jours[i]) - jourMs(jours[i - 1])) / 864e5));
  });
  ecarts.sort((a, b) => a - b);
  const mediane = ecarts.length ? ecarts[Math.floor(ecarts.length / 2)] : null;
  $('stVenues').textContent = cles.length;
  $('stNouvelles').textContent = nouvelles;
  $('stRetour').textContent = cles.length ? Math.round(reviennent / cles.length * 100) + ' %' : '–';
  $('stRythme').textContent = mediane !== null ? (mediane <= 1 ? '1 jour' : mediane + ' jours') : '–';
  $('stExplication').textContent = cles.length
    ? reviennent + ' personne' + (reviennent > 1 ? 's' : '') + ' sur ' + cles.length + (reviennent > 1 ? ' sont venues' : ' est venue') + ' au moins deux fois sur la période.' +
      (mediane !== null ? ' En général, ' + M('une cliente', 'un client') + ' revient ' + (mediane <= 1 ? 'tous les jours.' : 'tous les ' + mediane + ' jours.') : '')
    : 'Pas encore de saisies sur cette période.';

  // Prestations les plus demandées (une saisie « A + B » compte pour A et pour B)
  const prestas = {};
  L.forEach(r => String(r.prestation).split(' + ').map(x => x.trim()).filter(Boolean).forEach(p => { prestas[p] = (prestas[p] || 0) + 1; }));
  const top = {};
  Object.keys(prestas).sort((a, b) => prestas[b] - prestas[a]).slice(0, 8).forEach(k => { top[k] = prestas[k]; });
  barres($('stPrestations'), top, () => '', 'Aucune prestation sur cette période.', v => v + ' fois');

  // Meilleures clientes (encaissé sur la période)
  const z = $('stMeilleures'); z.innerHTML = '';
  const classement = cles.map(k => ({ k, ca: parCle[k].reduce((s, r) => s + montant(r), 0), nb: parCle[k].length }))
    .sort((a, b) => b.ca - a.ca || b.nb - a.nb).slice(0, 10);
  if (!classement.length) z.appendChild(el('p', 'discret', 'Personne sur cette période.'));
  classement.forEach((x, i) => {
    const c = D.clientes.find(y => y.cle === x.k);
    const k = el('div', 'carte' + (c ? ' cliquable' : ''));
    const l1 = el('div', 'ligne1'), g = el('span');
    g.style.display = 'flex'; g.style.alignItems = 'center';
    g.appendChild(el('span', 'rang', String(i + 1))); g.appendChild(el('span', '', c ? c.nom : parCle[x.k][0].client));
    l1.appendChild(g); l1.appendChild(el('span', '', euros(x.ca)));
    k.appendChild(l1);
    k.appendChild(el('div', 'ligne2', x.nb + ' passage' + (x.nb > 1 ? 's' : '') + ' · panier moyen ' + euros(x.ca / x.nb) + (c && c.derniere ? ' · vu' + M('e', '') + ' le ' + c.derniere : '')));
    if (c) k.onclick = () => ouvrirFiche(c.cle);
    z.appendChild(k);
  });

  // Rapport par heure : chaque prestation du tarif (prix ÷ durée)
  const rent = {};
  (D.tarifs || []).filter(t => !t.option && t.duree > 0 && t.prix > 0).forEach(t => { rent[t.nom] = Math.round(t.prix / t.duree * 60); });
  const zr = $('stRentabilite');
  barres(zr, rent, () => '', 'Ajoute la durée de tes prestations (Plus → Tarifs) pour voir lesquelles rapportent le plus par heure.', v => v + ' €/h');
  if (Object.keys(rent).length) zr.querySelectorAll('.cat .ligne1 span:last-child').forEach(x => { x.textContent = x.textContent.replace(/ · \d+ %$/, ''); });

  // Nombre de visites par personne
  const tranches = { '1 visite': 0, '2 à 4 visites': 0, '5 à 9 visites': 0, '10 visites et plus': 0 };
  cles.forEach(k => { const n = parCle[k].length; tranches[n === 1 ? '1 visite' : n < 5 ? '2 à 4 visites' : n < 10 ? '5 à 9 visites' : '10 visites et plus']++; });
  barres($('stFrequence'), tranches, () => '', 'Personne sur cette période.', v => v + ' pers.', true);

  // Jours les plus chargés
  const jours = {};
  [1, 2, 3, 4, 5, 6, 0].forEach(j => { jours[JOURS[j]] = 0; });
  L.forEach(r => { jours[JOURS[new Date(r.iso + 'T12:00:00').getDay()]]++; });
  barres($('stJours'), jours, () => '', 'Aucune prestation sur cette période.', v => v + ' prestation' + (v > 1 ? 's' : ''));
}

/* ======================= AGENDA ======================= */
let jourAgenda = null, rdvEdition = null, rdvEnCours = null;
const DUREES = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240];
const agenda = () => (D && D.agenda) || [];
const isoPlus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const heureTexte = h => String(h || '').replace(':', ' h ');
const minutes = h => { const m = String(h || '').match(/^(\d{2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : 0; };
const finRdv = r => { const t = minutes(r.heure) + (r.duree || 30); return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60); };
const jourLong = iso => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const ficheDe = nom => D.clientes.find(c => c.cle === norm(nom));
const dureeTexte = m => m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + pad(m % 60) : '');

/** Met à jour l'agenda reçu du Google Sheet (en gardant les changements pas encore envoyés). */
function majAgenda(liste) {
  if (!D || !liste) return;
  D.agenda = liste; lsSet(CLE_DONNEES, JSON.stringify(D));
  if (vueActive === 'agenda') afficherAgenda();
  if (vueActive === 'accueil') afficherAccueil();
}

/** Applique tout de suite le changement sur le téléphone, puis l'envoie au Google Sheet (même sans réseau : envoi plus tard). */
function envoyerRdv(r, supprimer) {
  if (abonnementBloque()) return afficherPaywall();
  const l = agenda().slice(), i = l.findIndex(x => x.id === r.id);
  if (supprimer) { if (i >= 0) l.splice(i, 1); }
  else {
    const x = Object.assign(i >= 0 ? l[i] : { statut: 'prévu', rappel: '', note: '', duree: 30 }, r);
    if (r.date) x.iso = r.date;
    if (r.rappel === true) x.rappel = new Date().toLocaleDateString('fr-FR');
    if (i < 0) l.push(x);
    l.sort((a, b) => (a.iso + a.heure).localeCompare(b.iso + b.heure));
  }
  D.agenda = l; lsSet(CLE_DONNEES, JSON.stringify(D));
  mettreEnAttente({ action: supprimer ? 'rdv_supprimer' : 'rdv', uid: uid(), extra: supprimer ? { id: r.id } : { r }, resume: 'rendez-vous' });
  envoyerAttente();
  if (vueActive === 'agenda') afficherAgenda();
  if (vueActive === 'accueil') afficherAccueil();
}

function texteRappel(r) {
  const demain = r.iso === isoPlus(D.aujourdHuiIso, 1), auj = r.iso === D.aujourdHuiIso;
  const quand = auj ? 'aujourd\'hui' : demain ? 'demain' : 'le ' + jourLong(r.iso);
  return 'Bonjour ' + prenom(r.client) + ', petit rappel de votre rendez-vous chez ' + nomSalon() + ' ' + quand + ' à ' + heureTexte(r.heure) +
    '.' + phraseFideliteAvant(ficheDe(r.client), r.iso) + ' En cas d\'empêchement, merci de répondre à ce message. À bientôt !';
}

/** Carte d'un rendez-vous. */
function carteRdv(r, compacte) {
  const k = el('div', 'carte rdv rdv-' + (r.statut === 'fait' ? 'fait' : r.statut === 'annulé' ? 'annule' : 'prevu'));
  const h = el('div', 'rdv-heure'); h.appendChild(el('b', '', r.heure)); h.appendChild(el('small', '', finRdv(r)));
  const c = el('div', 'rdv-corps');
  const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', r.client));
  if (r.statut === 'fait') l1.appendChild(el('span', 'badge', '✓ Encaissé'));
  else if (r.statut === 'annulé') l1.appendChild(el('span', 'badge badge-gris', 'Annulé'));
  else if (r.rappel) l1.appendChild(el('span', 'badge badge-gris', '✓ Rappel envoyé'));
  c.appendChild(l1);
  const det = [r.prestation, dureeTexte(r.duree), r.note].filter(Boolean).join(' · ');
  if (det) c.appendChild(el('div', 'ligne2', det));
  const act = el('div', 'actions');
  if (r.statut === 'prévu') {
    if (r.iso <= D.aujourdHuiIso) { const b = avecIco(el('button', 'lien', 'Encaisser'), 'portefeuille'); b.onclick = () => encaisserRdv(r); act.appendChild(b); }
    if (r.iso >= D.aujourdHuiIso) act.appendChild(avecIco(lienRappel(r, r.rappel ? 'Renvoyer le rappel' : 'Rappel SMS'), 'message'));
  }
  if (!compacte || r.statut !== 'prévu') { const b = avecIco(el('button', 'lien', 'Modifier'), 'crayon'); b.onclick = () => ouvrirRdv(r); act.appendChild(b); }
  if (act.children.length) c.appendChild(act);
  k.appendChild(h); k.appendChild(c);
  return k;
}

function lienRappel(r, texte) {
  const f = ficheDe(r.client);
  const a = el('a', 'lien lien-a', texte);
  a.href = lienSms(f && f.tel, texteRappel(r));
  a.onclick = () => { setTimeout(() => envoyerRdv({ id: r.id, rappel: true }), 400); };
  return a;
}

/** Carte « Rappels pour demain » : un toucher par personne, le message est déjà écrit. */
function carteRappels(zone) {
  zone.innerHTML = '';
  const demain = isoPlus(D.aujourdHuiIso, 1);
  const liste = agenda().filter(r => r.iso === demain && r.statut === 'prévu');
  if (!liste.length) return;
  const restants = liste.filter(r => !r.rappel).length;
  const k = el('div', 'carte rappels');
  const l1 = el('div', 'ligne1'); l1.appendChild(avecIco(el('span', 'titre-ico', 'Rappels pour demain'), 'message')); l1.appendChild(el('span', 'badge' + (restants ? ' badge-alerte' : ''), restants ? restants + ' à envoyer' : 'Tous envoyés ✓'));
  k.appendChild(l1);
  k.appendChild(el('div', 'ligne2', 'Touche un nom : le SMS s\'ouvre avec le message déjà écrit, il ne reste qu\'à l\'envoyer.'));
  const z = el('div', 'liens-clientes');
  liste.forEach(r => { const a = lienRappel(r, (r.rappel ? '✓ ' : '') + r.heure + ' · ' + r.client); a.className = 'puce' + (r.rappel ? ' envoye' : ''); z.appendChild(a); });
  k.appendChild(z);
  zone.appendChild(k);
}

function afficherRdvAccueil() {
  const z = $('rdvJour'); z.innerHTML = '';
  const jour = agenda().filter(r => r.iso === D.aujourdHuiIso && r.statut !== 'annulé');
  if (!jour.length) {
    const p = el('p', 'discret', 'Aucun rendez-vous aujourd\'hui. ');
    const b = el('button', 'lien', 'Ouvrir l\'agenda'); b.style.minHeight = '0'; b.style.padding = '0'; b.onclick = () => vue('agenda');
    p.appendChild(b); z.appendChild(p);
  }
  jour.forEach(r => z.appendChild(carteRdv(r, true)));
  carteRappels($('rappelsAccueil'));
}

function allerAujourdhui() { jourAgenda = D.aujourdHuiIso; afficherAgenda(); }
function changerSemaine(n) { jourAgenda = isoPlus(jourAgenda || D.aujourdHuiIso, 7 * n); afficherAgenda(); }

function afficherAgenda() {
  if (!D) return;
  if (!jourAgenda) jourAgenda = D.aujourdHuiIso;
  // Semaine du lundi au dimanche contenant le jour choisi
  const d = new Date(jourAgenda + 'T12:00:00'), decal = (d.getDay() + 6) % 7, lundi = isoPlus(jourAgenda, -decal);
  const z = $('jours'); z.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const iso = isoPlus(lundi, i), j = new Date(iso + 'T12:00:00');
    const nb = agenda().filter(r => r.iso === iso && r.statut !== 'annulé').length;
    const b = el('button', 'jour' + (iso === jourAgenda ? ' on' : '') + (iso === D.aujourdHuiIso ? ' auj' : ''));
    b.appendChild(el('small', '', j.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')));
    b.appendChild(el('b', '', String(j.getDate())));
    b.appendChild(el('i', nb ? 'plein' : '', nb ? String(nb) : ''));
    b.onclick = () => { jourAgenda = iso; modeAgenda = 'jour'; afficherAgenda(); };
    z.appendChild(b);
  }
  const liste = agenda().filter(r => r.iso === jourAgenda);
  const actifs = liste.filter(r => r.statut !== 'annulé');
  const duree = actifs.reduce((s, r) => s + (r.duree || 0), 0);
  $('titreJour').textContent = jourLong(jourAgenda) + (actifs.length ? ' · ' + actifs.length + ' rdv · ' + dureeTexte(duree) : '');
  const box = $('listeRdv'); box.innerHTML = '';
  if (!liste.length) box.appendChild(el('p', 'discret', 'Aucun rendez-vous ce jour-là.'));
  liste.forEach(r => box.appendChild(carteRdv(r, false)));
  carteRappels($('rappelsAgenda'));
  afficherSemaine(lundi);
}

/* Fenêtre de rendez-vous */
let rdvChoisis = [];
function ouvrirRdv(r, pre) {
  rdvEdition = r || null;
  $('rdvTitre').textContent = r ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous';
  $('rdvSupprimer').classList.toggle('cache', !r);
  const sd = $('rdvDuree'); sd.innerHTML = '';
  const duree = r ? r.duree : 30;
  DUREES.concat(DUREES.includes(duree) ? [] : [duree]).sort((a, b) => a - b).forEach(m => sd.appendChild(new Option(dureeTexte(m), m)));
  sd.value = duree;
  $('rdvClient').value = r ? r.client : '';
  $('rdvDate').value = r ? r.iso : (jourAgenda || D.aujourdHuiIso);
  $('rdvHeure').value = r ? r.heure : '';
  if (pre) { $('rdvDate').value = pre.date; $('rdvHeure').value = pre.heure; }
  $('rdvNote').value = r ? r.note : '';
  $('rdvPrestation').value = r ? r.prestation : '';
  rdvChoisis = r ? String(r.prestation).split(' + ').filter(n => D.tarifs.some(t => t.nom === n)) : [];
  const z = $('rdvPrestas'); z.innerHTML = '';
  D.tarifs.forEach(t => {
    const b = el('button', 'presta' + (rdvChoisis.includes(t.nom) ? ' on' : ''), t.nom);
    b.onclick = () => {
      const i = rdvChoisis.indexOf(t.nom);
      if (i >= 0) rdvChoisis.splice(i, 1); else rdvChoisis.push(t.nom);
      b.classList.toggle('on', i < 0);
      $('rdvPrestation').value = rdvChoisis.join(' + ');
      const d = dureeDe(rdvChoisis.join(' + '));
      if (d) { const sd = $('rdvDuree'); if (!Array.from(sd.options).some(o => Number(o.value) === d)) sd.appendChild(new Option(dureeTexte(d), d)); sd.value = d; }
    };
    z.appendChild(b);
  });
  $('modaleRdv').classList.remove('cache');
  document.body.style.overflow = 'hidden';
  if (!r) setTimeout(() => $('rdvClient').focus(), 320);
}
function fermerRdv() { $('modaleRdv').classList.add('cache'); document.body.style.overflow = ''; rdvEdition = null; }

function sauverRdv() {
  const saisi = $('rdvClient').value.trim();
  const f = saisi && ficheDe(saisi);
  const r = {
    id: rdvEdition ? rdvEdition.id : 'r' + uid(), client: f ? f.nom : saisi, date: $('rdvDate').value, heure: $('rdvHeure').value,
    duree: Number($('rdvDuree').value) || 30, prestation: $('rdvPrestation').value.trim(), note: $('rdvNote').value.trim(),
  };
  if (!r.client) return message(M('👉 Indique la cliente.', '👉 Indique le client.'));
  if (!r.date) return message('👉 Indique la date.');
  if (!/^\d{2}:\d{2}$/.test(r.heure)) return message('👉 Indique l\'heure.');
  const debut = minutes(r.heure), fin = debut + r.duree;
  const conflit = agenda().find(x => x.id !== r.id && x.iso === r.date && x.statut !== 'annulé' && minutes(x.heure) < fin && minutes(x.heure) + (x.duree || 30) > debut);
  if (conflit && !confirm('Attention : ce créneau chevauche le rendez-vous de ' + conflit.client + ' (' + conflit.heure + ' – ' + finRdv(conflit) + ').\n\nEnregistrer quand même ?')) return;
  const change = rdvEdition && (rdvEdition.iso !== r.date || rdvEdition.heure !== r.heure);
  if (change) r.rappel = false; // nouvel horaire : un nouveau rappel sera à envoyer
  fermerRdv();
  jourAgenda = r.date;
  envoyerRdv(r);
  vibrer(14);
  message('📅 Rendez-vous enregistré : ' + r.client + ', ' + jourLong(r.date) + ' à ' + heureTexte(r.heure) + '.');
  if (vueActive !== 'agenda' && vueActive !== 'accueil') vue('agenda');
}

function supprimerRdv() {
  const r = rdvEdition;
  if (!r) return;
  if (abonnementBloque()) return afficherPaywall();
  fermerRdv();
  const i = agenda().indexOf(r);
  const majVues = () => { if (vueActive === 'agenda') afficherAgenda(); if (vueActive === 'accueil') afficherAccueil(); };
  actionAnnulable('Rendez-vous de ' + r.client + ' supprimé',
    () => { D.agenda = agenda().filter(x => x !== r); majVues(); },
    () => envoyerRdv({ id: r.id }, true),
    () => { D.agenda.splice(Math.max(0, i), 0, r); majVues(); });
}

/** « Encaisser » : ouvre une nouvelle prestation déjà remplie avec le rendez-vous. */
function encaisserRdv(r) {
  nouvelleSaisie();
  const f = ficheDe(r.client);
  choisirCliente(f || { nom: r.client, cle: norm(r.client), total: 0, depuis: 0, nouvelle: true });
  String(r.prestation).split(' + ').forEach(n => {
    const b = Array.from(document.querySelectorAll('#prestations .presta, #options .presta')).find(x => x.firstChild && x.firstChild.nodeValue === n);
    if (b) b.click();
  });
  $('date').value = r.iso; $('heure').value = r.heure;
  majResume();
  rdvEnCours = r.id;
  vue('nouvelle');
}

/* ======================= RÉGLAGES (écran Plus → Réglages) ======================= */
const COULEURS_APERCU = { 'Prune et rose': '#d6457a', 'Bleu nuit': '#3b82c4', 'Vert sauge': '#6b9a7d', 'Noir et or': '#b08d57', 'Terracotta': '#c8643b', 'Lavande': '#8a74c9' };
let regEdition = null;

function afficherReglagesEcran() {
  if (!D || !D.reglages) return;
  const g = D.reglages, p = g.plus || {};
  regEdition = { metier: g.metier, mot: g.mot, couleur: p.couleur || 'Prune et rose', modules: Object.assign({}, g.modules) };
  const z = $('formReglages'); z.innerHTML = '';
  const bloc = titre => { const b = el('div', 'carte'); b.appendChild(el('div', 'ligne1', titre)); z.appendChild(b); return b; };
  const champ = (parent, id, label, valeur, attrs, aide) => {
    const l = el('label', 'etiquette', label); l.htmlFor = id; parent.appendChild(l);
    const i = el('input'); i.id = id; i.type = 'text'; i.value = valeur === null || valeur === undefined ? '' : valeur;
    Object.assign(i, attrs || {}); parent.appendChild(i);
    if (aide) parent.appendChild(el('div', 'ligne2', aide));
    return i;
  };
  const puces = (parent, liste, actuel, quand) => {
    const w = el('div', 'paiements'); w.style.marginTop = '8px';
    liste.forEach(([val, txt, couleur]) => {
      const b = el('button', 'puce' + (val === actuel ? ' on' : ''));
      if (couleur) { const pt = el('i', 'pastille'); pt.style.background = couleur; b.appendChild(pt); }
      b.appendChild(document.createTextNode(txt));
      b.onclick = () => { w.querySelectorAll('.puce').forEach(x => x.classList.toggle('on', x === b)); quand(val); };
      w.appendChild(b);
    });
    parent.appendChild(w);
  };

  // Mon activité
  const b1 = bloc('Mon activité');
  champ(b1, 'regNom', 'Nom affiché en haut', g.nomSalon, { maxLength: 60 });
  b1.appendChild(el('label', 'etiquette', 'Clientèle'));
  puces(b1, [['Cliente', '👩 Surtout des femmes'], ['Client', '👨 Surtout des hommes'], ['Mixte', '👥 Mixte']], g.mot, v => { regEdition.mot = v; });

  // Apparence
  const b2 = bloc('Apparence');
  b2.appendChild(el('label', 'etiquette', 'Couleur'));
  puces(b2, (g.themes || Object.keys(COULEURS_APERCU)).map(t => [t, t, COULEURS_APERCU[t]]), regEdition.couleur, v => { regEdition.couleur = v; });
  regEdition.logo = p.logo || '';
  b2.appendChild(el('label', 'etiquette', 'Logo (facultatif)'));
  const lz = el('div', 'logo-choix');
  const apercu = el('div', 'logo-apercu');
  const majApercu = () => {
    apercu.innerHTML = '';
    if (regEdition.logo) { const im = el('img'); im.src = regEdition.logo; im.alt = 'Logo'; apercu.appendChild(im); }
    else apercu.textContent = icone();
    bSup.classList.toggle('cache', !regEdition.logo);
  };
  const fichier = el('input'); fichier.type = 'file'; fichier.accept = 'image/*'; fichier.className = 'cache';
  fichier.onchange = () => { const f = fichier.files && fichier.files[0]; if (f) reduireImage(f).then(u => { regEdition.logo = u; majApercu(); }).catch(e => erreur(e)); fichier.value = ''; };
  const bChoisir = el('button', 'lien', '📷 Choisir une image'); bChoisir.onclick = () => fichier.click();
  const bSup = el('button', 'lien danger', 'Retirer'); bSup.onclick = () => { regEdition.logo = ''; majApercu(); };
  const actions = el('div', 'logo-actions'); actions.appendChild(bChoisir); actions.appendChild(bSup);
  lz.appendChild(apercu); lz.appendChild(actions); lz.appendChild(fichier);
  b2.appendChild(lz);
  b2.appendChild(el('div', 'ligne2', 'Une photo ou ton logo, depuis la galerie du téléphone. Sans logo : l\'icône du métier.'));
  majApercu();

  // Fonctions
  const b3 = bloc('Fonctions de l\'application');
  b3.appendChild(el('div', 'ligne2', 'Décoche ce dont tu ne te sers pas : l\'application devient plus simple.'));
  (g.modulesListe || []).forEach(m => {
    const l = el('label', 'interrupteur');
    const t = el('span', 'interrupteur-texte'); t.appendChild(el('b', '', m.nom)); t.appendChild(el('small', '', m.aide));
    const c = el('input'); c.type = 'checkbox'; c.checked = regEdition.modules[m.cle] !== false;
    c.onchange = () => { regEdition.modules[m.cle] = c.checked; };
    l.appendChild(t); l.appendChild(c); l.appendChild(el('span', 'interrupteur-glissiere'));
    b3.appendChild(l);
  });

  // Clients et SMS
  const b4 = bloc('Clients');
  champ(b4, 'regAvis', 'Lien pour laisser un avis Google (facultatif)', p.avis, { placeholder: 'https://g.page/r/…', inputMode: 'url' },
    'Google Maps → ta fiche → « Demander des avis » → copier le lien. Ajoute le bouton « Avis Google ».');
  champ(b4, 'regRelance', 'Client à relancer après combien de jours sans visite', p.relance || 60, { type: 'number', inputMode: 'numeric', min: 1 },
    'Il apparaît alors dans « À surveiller » sur l\'accueil, avec un bouton pour lui écrire. Aucun SMS n\'est envoyé tout seul : c\'est toi qui décides.');
  champ(b4, 'regDeplacement', 'Frais de déplacement à domicile (€, facultatif)', p.deplacement, { inputMode: 'decimal' },
    'Ajoute un bouton « Déplacement » à la saisie. Vide = pas de bouton.');

  // Chiffres
  const b5 = bloc('Mes chiffres');
  champ(b5, 'regObjectif', 'Objectif de chiffre d\'affaires par mois (€, facultatif)', p.objectif, { inputMode: 'decimal' });
  champ(b5, 'regSeuil', 'Plafond micro-entreprise (€ par an, facultatif)', p.seuil, { inputMode: 'decimal' },
    'Alerte quand tu approches du plafond. Vérifie le montant chaque année sur autoentrepreneur.urssaf.fr.');
  champ(b5, 'regUrssaf', 'Taux de cotisations URSSAF (%, facultatif)', p.urssaf, { inputMode: 'decimal', placeholder: 'ex. 21,2' },
    'Pour estimer ce qu\'il faut mettre de côté. Ton taux est dans ton espace URSSAF.');

  // Code
  const b6 = bloc('Code d\'accès');
  b6.appendChild(el('div', 'ligne2', 'Laisse vide pour garder ton code actuel.'));
  champ(b6, 'regPin', 'Nouveau code (4 à 8 chiffres)', '', { type: 'password', inputMode: 'numeric', maxLength: 8, autocomplete: 'new-password' });
  champ(b6, 'regPin2', 'Encore une fois', '', { type: 'password', inputMode: 'numeric', maxLength: 8, autocomplete: 'new-password' });
  if (SALON) {
    champ(b6, 'regEmail', 'Ton e-mail (pour le « Code oublié ? »)', (g.email || ''), { inputMode: 'email', autocomplete: 'email', maxLength: 120, placeholder: 'ex. prenom@gmail.com' },
      'Si tu oublies ton code, tu recevras un lien à cette adresse pour en choisir un nouveau.');
    b6.appendChild(el('label', 'etiquette', 'Code de secours'));
    b6.appendChild(el('div', 'ligne2', 'Il permet de choisir un nouveau code si tu oublies le tien (lien « Code oublié ? »). Crée-le et garde-le précieusement : capture d\'écran, note…'));
    const zs = el('div', 'secours-boite cache'); zs.id = 'regSecours';
    const bs = el('button', 'lien', '🔑 Créer un code de secours');
    bs.onclick = () => {
      if (!confirm('Créer un nouveau code de secours ?\n\nL\'ancien (s\'il existe) ne marchera plus.')) return;
      bs.disabled = true;
      api('creer_secours').then(j => {
        zs.textContent = ''; zs.classList.remove('cache');
        zs.appendChild(el('div', 'secours-code', j.data.secours));
        zs.appendChild(el('div', 'ligne2', '📸 Fais une capture d\'écran maintenant : ce code ne sera plus jamais affiché.'));
      }).catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e)).finally(() => { bs.disabled = false; });
    };
    b6.appendChild(bs); b6.appendChild(zs);
  }
}

/** Réduit l'image choisie en carré de 192 px (léger : enregistré directement dans le Google Sheet). */
function reduireImage(f) {
  return new Promise((ok, ko) => {
    if (!/^image\//.test(f.type)) return ko(new Error('Choisis une image.'));
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => {
      const T = 192, c = document.createElement('canvas'); c.width = T; c.height = T;
      const x = c.getContext('2d'), cote = Math.min(img.width, img.height);
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, T, T);
      x.drawImage(img, (img.width - cote) / 2, (img.height - cote) / 2, cote, cote, 0, 0, T, T); // centré, recadré en carré
      URL.revokeObjectURL(url);
      let q = 0.85, d = c.toDataURL('image/jpeg', q);
      while (d.length > 40000 && q > 0.4) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
      ok(d);
    };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('Image illisible, essaie une autre photo.')); };
    img.src = url;
  });
}

function sauverReglages() {
  const v = id => $(id).value.trim();
  const pin = v('regPin');
  if (v('regNom').length < 2) return message('👉 Indique le nom affiché.');
  if (pin && !/^\d{4,8}$/.test(pin)) return message('👉 Le code doit faire de 4 à 8 chiffres.');
  if (pin && pin !== v('regPin2')) return message('👉 Les deux codes ne sont pas identiques.');
  if ($('regEmail') && v('regEmail') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('regEmail'))) return message('👉 Adresse e-mail invalide.');
  if (v('regAvis') && !/^https:\/\/\S+$/.test(v('regAvis'))) return message('👉 Le lien d\'avis doit commencer par https://');
  const r = {
    nom: v('regNom'), metier: regEdition.metier, mot: regEdition.mot, modules: regEdition.modules, pin,
    email: $('regEmail') ? v('regEmail') : undefined,
    plus: { couleur: regEdition.couleur, logo: regEdition.logo, avis: v('regAvis'), relance: v('regRelance'), deplacement: v('regDeplacement'),
      objectif: v('regObjectif'), seuil: v('regSeuil'), urssaf: v('regUrssaf') },
  };
  const b = $('btnReglages'); b.disabled = true; b.textContent = 'Enregistrement…';
  api('reglages', { r })
    .then(j => {
      if (pin) { PIN = pin; lsSet(CLE_PIN, pin); }
      majTout(j.data.data); afficherEnTete(); afficherReglagesEcran();
      message('✅ Réglages enregistrés.' + (j.data.tarifs === 'remplaces' ? ' Tarifs du nouveau métier chargés.' : j.data.tarifs === 'gardes' ? ' Tes tarifs personnalisés ont été gardés.' : '') + (pin ? ' Nouveau code actif.' : ''), 5000);
    })
    .catch(e => erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e))
    .finally(() => { b.disabled = false; b.textContent = 'Enregistrer les réglages'; });
}

/* ======================= IMPORT DES CLIENTS ======================= */
let importListe = [];

/** Anniversaire « 1990-04-09 », « --04-09 », « 09/04/1990 »… → « 09/04 ». */
function annivCourt(v) {
  const t = String(v || '').trim();
  let m = t.match(/(\d{4}|-)-?(\d{2})-?(\d{2})$/) || t.match(/^-?-?(\d{2})(\d{2})$/);
  if (m && m.length === 4) return m[3] + '/' + m[2];
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})/);
  return m ? pad(+m[1]) + '/' + pad(+m[2]) : '';
}

/** Cartes de contact (.vcf). */
function lireVcf(texte) {
  const deplie = texte.replace(/\r?\n[ \t]/g, ''); // lignes repliées
  return deplie.split(/BEGIN:VCARD/i).slice(1).map(bloc => {
    const champ = cle => { const m = bloc.match(new RegExp('^' + cle + '(?:;[^:\\n]*)?:(.*)$', 'im')); return m ? m[1].trim() : ''; };
    const dec = v => v.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ');
    let nom = dec(champ('FN'));
    const n = champ('N').split(';').map(dec);
    if (!nom) nom = [n[1], n[0]].filter(Boolean).join(' ');
    return { nom, nomFamille: n[0] || '', tel: champ('TEL'), anniversaire: annivCourt(champ('BDAY')), notes: dec(champ('NOTE')) };
  }).filter(c => c.nom);
}

/** Tableau .csv (séparateur ; ou ,) avec une ligne d'en-têtes. */
function lireCsv(texte) {
  const lignes = texte.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lignes.length < 2) return [];
  const sep = (lignes[0].match(/;/g) || []).length >= (lignes[0].match(/,/g) || []).length ? ';' : ',';
  const decoupe = l => { const r = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === sep && !q) { r.push(cur); cur = ''; } else cur += ch; }
    r.push(cur); return r.map(x => x.trim()); };
  const tetes = decoupe(lignes[0]).map(x => norm(x));
  const col = (...noms) => tetes.findIndex(t => noms.some(n => t === n || t.indexOf(n) === 0));
  const iNomComplet = col('nom complet', 'name', 'full name', 'display name');
  const iPrenom = col('prenom', 'first name', 'given name');
  const iNom = col('nom de famille', 'nom', 'last name', 'family name');
  const iTel = col('telephone', 'tel', 'portable', 'mobile', 'phone 1 - value', 'phone', 'numero');
  const iAnniv = col('anniversaire', 'date de naissance', 'birthday', 'naissance');
  const iNotes = col('notes', 'note', 'remarques', 'commentaire');
  return lignes.slice(1).map(l => {
    const v = decoupe(l), g = i => (i >= 0 ? v[i] || '' : '');
    const nom = g(iNomComplet) || [g(iPrenom), iNom !== iNomComplet ? g(iNom) : ''].filter(Boolean).join(' ');
    return { nom, nomFamille: iPrenom >= 0 ? g(iNom) : '', tel: g(iTel), anniversaire: annivCourt(g(iAnniv)), notes: g(iNotes) };
  }).filter(c => c.nom);
}

function importerDepuisFichier(input) {
  const f = input.files && input.files[0]; input.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const t = String(r.result || '');
    const liste = /BEGIN:VCARD/i.test(t) ? lireVcf(t) : lireCsv(t);
    if (!liste.length) return message('👉 Aucun contact trouvé dans ce fichier (il faut une colonne Nom ou Prénom).', 6000);
    apercuImport(liste);
  };
  r.onerror = () => erreur('Fichier illisible.');
  r.readAsText(f);
}

async function importerDepuisContacts() {
  try {
    const choix = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    const liste = choix.map(x => ({ nom: (x.name && x.name[0]) || '', tel: (x.tel && x.tel[0]) || '' })).filter(c => c.nom);
    if (liste.length) apercuImport(liste);
  } catch (e) { erreur('Contacts non disponibles sur ce téléphone : utilise un fichier.'); }
}

function apercuImport(liste) {
  const connus = new Set(D.clientes.map(c => c.cle));
  const vus = new Set();
  importListe = liste.filter(c => { const k = norm(c.nom); if (!k || connus.has(k) || vus.has(k)) return false; vus.add(k); return true; });
  const doublons = liste.length - importListe.length;
  const z = $('importApercu'); z.innerHTML = '';
  const k = el('div', 'carte');
  k.appendChild(el('div', 'ligne1', importListe.length + ' ' + M('cliente', 'client') + (importListe.length > 1 ? 's' : '') + ' à ajouter'));
  if (doublons) k.appendChild(el('div', 'ligne2', doublons + ' déjà présent' + (doublons > 1 ? 's' : '') + ' ou en double : ignoré' + (doublons > 1 ? 's' : '') + '.'));
  const ul = el('div', 'liens-clientes');
  importListe.slice(0, 30).forEach(c => ul.appendChild(el('span', 'puce', c.nom + (c.tel ? ' 📞' : ''))));
  if (importListe.length > 30) ul.appendChild(el('span', 'discret', '… et ' + (importListe.length - 30) + ' autres'));
  k.appendChild(ul);
  if (importListe.length) {
    const b = el('button', 'gros', 'Importer ' + importListe.length + ' ' + M('cliente', 'client') + (importListe.length > 1 ? 's' : ''));
    b.id = 'btnImporter'; b.onclick = validerImport;
    k.appendChild(b);
  }
  z.appendChild(k);
  z.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function validerImport() {
  if (!importListe.length) return;
  const b = $('btnImporter'); b.disabled = true; b.textContent = 'Import en cours…';
  api('importer_clients', { liste: importListe })
    .then(j => {
      majTout(j.data.data);
      $('importApercu').innerHTML = '';
      message('✅ ' + j.data.ajoutes + ' ' + M('cliente', 'client') + (j.data.ajoutes > 1 ? 's' : '') + ' importé' + M('e', '') + (j.data.ajoutes > 1 ? 's' : '') + '.', 5000);
      importListe = [];
      vue('clientes');
    })
    .catch(e => { erreur(e.horsLigne ? 'Pas d\'internet : réessaie quand le réseau revient.' : e); b.disabled = false; b.textContent = 'Réessayer'; });
}

/* ======================= ABONNEMENT ======================= */
let paiementVerifie = false;
const abonnementBloque = () => !!(D && D.abonnement && D.abonnement.bloque);
const LIBELLES_ABO = { essai: 'Essai gratuit', actif: 'Abonnement actif', annule_fin: 'Résilié (actif jusqu\'à la fin de la période)', expire: 'Essai terminé', impaye: 'Paiement en attente', annule: 'Abonnement terminé', gratuit: 'Gratuit' };
const dateCourte = iso => iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

/** Carte sur l'accueil : jours d'essai restants, ou abonnement terminé. */
function afficherCarteAbo() {
  const z = $('carteAbo'); z.innerHTML = '';
  const a = D.abonnement;
  if (!a || a.statut === 'gratuit' || a.statut === 'actif') return;
  if (a.statut === 'essai' && a.jours > 7) {
    const p = el('div', 'abo-discret'); p.textContent = '🎁 Essai gratuit : encore ' + a.jours + ' jours · ';
    const b = el('button', 'lien', 'En savoir plus'); b.onclick = () => vue('abonnement'); p.appendChild(b); z.appendChild(p);
    return;
  }
  const k = el('div', 'carte abo-carte' + (a.bloque ? ' bloque' : ''));
  k.appendChild(el('div', 'ligne1', a.bloque ? '🔒 ' + LIBELLES_ABO[a.statut] : '⏳ Essai gratuit : plus que ' + a.jours + ' jour' + (a.jours > 1 ? 's' : '')));
  k.appendChild(el('div', 'ligne2', a.bloque
    ? 'Tes données sont conservées : tu peux les consulter et les exporter. Abonne-toi pour enregistrer à nouveau.'
    : 'Abonne-toi pour continuer à tout enregistrer après l\'essai (' + a.prix + ', sans engagement).'));
  const b = el('button', 'gros', 'S\'abonner'); b.onclick = () => vue('abonnement'); k.appendChild(b);
  z.appendChild(k);
}

function afficherPaywall() { if (D) vue('abonnement'); }

function afficherAbonnement() {
  const z = $('contenuAbo'); z.innerHTML = '';
  const a = D.abonnement || { statut: 'gratuit' };
  const k = el('div', 'carte');
  const l1 = el('div', 'ligne1'); l1.appendChild(el('span', '', LIBELLES_ABO[a.statut] || a.statut));
  l1.appendChild(el('span', 'badge' + (a.bloque ? ' badge-alerte' : ''), a.bloque ? 'Lecture seule' : 'Tout est ouvert'));
  k.appendChild(l1);
  if (a.statut === 'essai') k.appendChild(el('div', 'ligne2', 'Ton essai gratuit se termine le ' + dateCourte(a.fin) + ' (encore ' + a.jours + ' jour' + (a.jours > 1 ? 's' : '') + ').'));
  if (a.statut === 'actif') k.appendChild(el('div', 'ligne2', 'Prochain renouvellement : ' + dateCourte(a.fin) + '. Merci pour ta confiance 💛'));
  if (a.statut === 'annule_fin') k.appendChild(el('div', 'ligne2', 'Tout reste ouvert jusqu\'au ' + dateCourte(a.fin) + '.'));
  if (a.bloque) k.appendChild(el('div', 'ligne2', 'Tes données sont conservées : clients, historique, bilan et livre des recettes restent consultables et exportables. Pour enregistrer à nouveau, abonne-toi.'));
  z.appendChild(k);
  if (a.statut !== 'actif' && a.statut !== 'gratuit') {
    const o = el('div', 'carte abo-offre');
    o.appendChild(el('div', 'abo-prix', a.prix || ''));
    o.appendChild(el('div', 'ligne2', 'Sans engagement, résiliable à tout moment. Paiement sécurisé par Stripe : ta carte n\'est jamais vue par l\'application.'));
    ['Clients, fidélité et carte de fidélité', 'Agenda et rappels SMS', 'Bilan, taux horaire et livre des recettes', 'Sauvegarde automatique chaque semaine']
      .forEach(t => o.appendChild(el('div', 'abo-point', '✓ ' + t)));
    if (a.lienPaiement) { const b = el('a', 'gros bouton-lien', 'S\'abonner'); b.href = a.lienPaiement; o.appendChild(b); }
    else o.appendChild(el('p', 'discret', 'Le paiement en ligne arrive bientôt. En attendant, contacte la personne qui t\'a donné l\'application.'));
    const v = el('button', 'lien', 'J\'ai déjà payé : vérifier'); v.style.display = 'block'; v.style.margin = '12px auto 0'; v.onclick = () => verifierPaiement(false);
    o.appendChild(v);
    z.appendChild(o);
  }
  if (a.lienPortail && (a.statut === 'actif' || a.statut === 'annule_fin' || a.statut === 'impaye')) {
    const g = el('a', 'gros secondaire bouton-lien', 'Gérer mon abonnement (carte, factures, résiliation)'); g.href = a.lienPortail; g.target = '_blank'; g.rel = 'noopener';
    z.appendChild(g);
  }
}

function verifierPaiement(silencieux) {
  if (!silencieux) message('⏳ Vérification du paiement…', 6000);
  api('verifier_abonnement')
    .then(j => {
      if (j.data && j.data.abonnement) { D.abonnement = j.data.abonnement; lsSet(CLE_DONNEES, JSON.stringify(D)); }
      if (j.data && j.data.trouve) { message('✅ Merci ! Ton abonnement est actif.', 5000); appliquerReglages(); vue('accueil'); }
      else if (!silencieux) message('Paiement pas encore trouvé. S\'il vient d\'être fait, réessaie dans une minute.', 6000);
      if (vueActive === 'abonnement') afficherAbonnement();
    })
    .catch(e => { if (!silencieux) erreur(e); });
}

/* ======================= ERGONOMIE ET DESIGN ======================= */

/* ---------- Icônes (même style que le menu) ---------- */
const ICO = {
  crayon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  tel: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  portefeuille: '<path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M3 6.5A2 2 0 0 0 5 8h15a1 1 0 0 1 1 1v3h-4a2 2 0 0 0 0 4h4"/>',
  especes: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  carte: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
  mobile: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/>',
  recu: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  banque: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
  inconnu: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/>',
  etoile: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  ticket: '<path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z"/><path d="M14 6v2M14 11v2M14 16v2"/>',
  oeil: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  relance: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  etincelles: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>',
  repeter: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  poubelle: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/><path d="M10 11v6M14 11v6"/>',
  agenda: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
function ico(nom) {
  const s = el('span', 'ico');
  s.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[nom] || '') + '</svg>';
  return s;
}
function avecIco(e, nom) { e.insertBefore(ico(nom), e.firstChild); e.classList.add('avec-ico'); return e; }
const ICO_PAIEMENT = { 'Espèces': 'especes', 'Carte': 'carte', 'Wero': 'mobile', 'Chèque': 'recu', 'Virement': 'banque', 'Autre': 'mobile', 'Non renseigné': 'inconnu' };

/* ---------- Petite vibration de confirmation (Android) ---------- */
function vibrer(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* non disponible */ } }

/* ---------- Pastilles avec initiales ---------- */
function initiales(nom) {
  const m = String(nom || '').trim().split(' ').filter(Boolean);
  return ((m[0] || '?').charAt(0) + (m[1] ? m[1].charAt(0) : '')).toUpperCase();
}
function teinteNom(nom) { let h = 0; for (const ch of norm(nom)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function avatar(nom, grand) {
  const a = el('span', 'avatar' + (grand ? ' grand' : ''), initiales(nom));
  a.style.background = 'hsl(' + teinteNom(nom) + ' 52% 47%)';
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/* ---------- Annuler au lieu de confirmer ---------- */
let annulationEnCours = null;
function actionAnnulable(texte, appliquer, valider, retablir) {
  finirAnnulation();
  appliquer();
  vibrer(10);
  const a = { valider, retablir, t: setTimeout(finirAnnulation, 5000) };
  annulationEnCours = a;
  const m = $('msg'); m.innerHTML = '';
  m.appendChild(el('span', 'msg-texte', texte));
  const b = el('button', 'msg-annuler', 'Annuler');
  b.onclick = () => {
    if (annulationEnCours !== a) return;
    clearTimeout(a.t); annulationEnCours = null; m.style.display = 'none';
    a.retablir(); message('↩︎ Annulé.', 1800);
  };
  m.appendChild(b); m.style.display = 'flex';
  clearTimeout(m._t); m._t = setTimeout(() => { m.style.display = 'none'; }, 5000);
}
function finirAnnulation() { const a = annulationEnCours; if (!a) return; annulationEnCours = null; clearTimeout(a.t); a.valider(); }
window.addEventListener('pagehide', finirAnnulation);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') finirAnnulation(); });
function rafraichirApresLocal() { rafraichir(); if (vueActive === 'fiche' && ficheCle) ouvrirFiche(ficheCle, true); }

/* ---------- Saisie éclair : « Comme la dernière fois » et prestations les plus faites en premier ---------- */
function derniereVisite(cle) {
  for (let i = D.journal.length - 1; i >= 0; i--) if (D.journal[i].cle === cle) return D.journal[i];
  return null;
}
function frequencePrestations() {
  const f = {};
  D.journal.slice(-300).forEach(r => String(r.prestation || '').split(' + ').forEach(n => { f[n] = (f[n] || 0) + 1; }));
  return f;
}
function tarifsTries() {
  if (D.journal.length < 10) return D.tarifs;
  const f = frequencePrestations();
  return D.tarifs.map((t, i) => ({ t, i })).sort((a, b) => (f[b.t.nom] || 0) - (f[a.t.nom] || 0) || a.i - b.i).map(x => x.t);
}
const boutonsPrestas = () => Array.from(document.querySelectorAll('#prestations .presta, #options .presta, #choixDeplacement .presta'));
function afficherDejaFait() {
  const z = $('dejaFait'); z.innerHTML = '';
  const r = cliente && !cliente.nouvelle && !GENERIQUES.includes(cliente.cle) && derniereVisite(cliente.cle);
  if (!r) return;
  const noms = String(r.prestation || '').split(' + ').filter(n => boutonsPrestas().some(b => b.firstChild && b.firstChild.nodeValue === n));
  if (!noms.length) return;
  const b = el('button', 'deja-fait');
  b.appendChild(ico('repeter'));
  const t = el('span', 'deja-texte');
  t.appendChild(el('b', '', 'Comme la dernière fois'));
  t.appendChild(el('small', '', noms.join(' + ') + (r.paiement && mod('paiement') ? ' · ' + r.paiement : '') + ' · ' + r.date));
  b.appendChild(t);
  b.onclick = () => reprendre(noms, r.paiement);
  z.appendChild(b);
}
function reprendre(noms, paiement) {
  boutonsPrestas().filter(b => b.classList.contains('on')).forEach(b => b.click());
  noms.forEach(n => { const b = boutonsPrestas().find(x => x.firstChild && x.firstChild.nodeValue === n); if (b && !b.classList.contains('on')) b.click(); });
  if (paiement && mod('paiement')) { const p = Array.from(document.querySelectorAll('#choixPaiement .puce')).find(x => x.dataset.mode === paiement); if (p) p.click(); }
  vibrer(10);
  message('✓ Repris : ' + noms.join(' + ') + '. Vérifie le prix puis enregistre.', 3000);
}

/* ---------- Gestes : glisser une fiche ---------- */
function glissable(carte, gauche, droite) {
  const w = el('div', 'glisse');
  const fond = el('div', 'glisse-fond');
  const zD = el('div', 'glisse-droite');
  if (droite) { zD.appendChild(ico(droite.ico)); zD.appendChild(el('span', '', droite.txt)); }
  const zG = el('div', 'glisse-gauche');
  gauche.forEach(a => {
    const x = el(a.href ? 'a' : 'button', 'glisse-action ' + (a.cls || ''));
    if (a.href) x.href = a.href; else x.onclick = a.action;
    x.appendChild(ico(a.ico)); x.appendChild(el('span', '', a.txt));
    zG.appendChild(x);
  });
  fond.appendChild(zD); fond.appendChild(zG);
  w.appendChild(fond); w.appendChild(carte);
  const largeurG = gauche.length * 78;
  let x0 = 0, y0 = 0, dx = 0, sens = null, ouvert = 0, glisse = false;
  const poser = v => { carte.style.transform = v ? 'translateX(' + v + 'px)' : ''; };
  carte.addEventListener('touchstart', e => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; sens = null; glisse = false; dx = ouvert;
    carte.style.transition = 'none';
  }, { passive: true });
  carte.addEventListener('touchmove', e => {
    const t = e.touches[0], ddx = t.clientX - x0, ddy = t.clientY - y0;
    if (sens === null) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      sens = Math.abs(ddx) > Math.abs(ddy) * 1.3 ? 'h' : 'v';
      if (sens === 'h') fermerGlisses(w);
    }
    if (sens !== 'h') return;
    glisse = true;
    dx = ouvert + ddx;
    if (!droite && dx > 0) dx = 0;
    if (!gauche.length && dx < 0) dx = 0;
    if (dx < -largeurG) dx = -largeurG + (dx + largeurG) / 3;
    w.classList.toggle('vers-droite', dx > 0);
    w.classList.toggle('pret', dx > 90);
    poser(dx);
  }, { passive: true });
  carte.addEventListener('touchend', () => {
    carte.style.transition = '';
    if (sens !== 'h') return;
    if (dx > 90 && droite) { vibrer(12); ouvert = 0; poser(0); setTimeout(droite.action, 150); }
    else if (gauche.length && dx < -largeurG / 2) { ouvert = -largeurG; poser(ouvert); vibrer(6); }
    else { ouvert = 0; poser(0); }
    w.classList.remove('pret');
  });
  carte.addEventListener('click', e => {
    if (glisse || ouvert) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (!glisse && ouvert) { ouvert = 0; poser(0); }
      glisse = false;
    }
  }, true);
  w._fermer = () => { if (ouvert) { ouvert = 0; poser(0); } };
  return w;
}
function fermerGlisses(sauf) { document.querySelectorAll('.glisse').forEach(g => { if (g !== sauf && g._fermer) g._fermer(); }); }
function prestationPour(c) {
  if (abonnementBloque()) return afficherPaywall();
  nouvelleSaisie(); choisirCliente(c); vue('nouvelle');
}

/* ---------- Recherche globale (accueil) ---------- */
function ligneResultat(icone, titre, sous, action) {
  const b = el('button', 'resultat');
  b.appendChild(icone);
  const t = el('span', 'resultat-texte'); t.appendChild(el('b', '', titre)); if (sous) t.appendChild(el('small', '', sous));
  b.appendChild(t); b.appendChild(el('span', 'chevron', '›'));
  b.onclick = action;
  return b;
}
function videRecherche() { const i = $('rechercheGlobale'); if (i.value) { i.value = ''; rechercheGlobale(); } }
function rechercheGlobale() {
  const brut = $('rechercheGlobale').value, q = norm(brut), z = $('resultatsGlobaux');
  z.innerHTML = '';
  z.classList.toggle('cache', !q);
  document.body.classList.toggle('recherche-active', !!q);
  if (!q || !D) return;
  const chiffres = brut.replace(/[^0-9]/g, '');
  const clientes = D.clientes.filter(c => norm(c.nom).includes(q) || norm(c.nomFamille || '').includes(q) ||
    (chiffres.length >= 3 && String(c.tel || '').replace(/[^0-9]/g, '').includes(chiffres))).slice(0, 6);
  const rdv = agenda().filter(r => r.iso >= D.aujourdHuiIso && r.statut !== 'annulé' && (norm(r.client).includes(q) || norm(r.prestation || '').includes(q))).slice(0, 4);
  const saisies = D.journal.filter(r => norm(r.prestation || '').includes(q) || norm(r.client).includes(q) || r.date.includes(brut.trim())).slice(-5).reverse();
  if (clientes.length) {
    z.appendChild(el('div', 'resultats-titre', M('Clientes', 'Clients')));
    clientes.forEach(c => z.appendChild(ligneResultat(avatar(c.nom), c.nom, infoCliente(c), () => { videRecherche(); ouvrirFiche(c.cle); })));
  }
  if (rdv.length) {
    z.appendChild(el('div', 'resultats-titre', 'Rendez-vous à venir'));
    rdv.forEach(r => z.appendChild(ligneResultat(ico('agenda'), r.client, jourLong(r.iso) + ' à ' + heureTexte(r.heure) + (r.prestation ? ' · ' + r.prestation : ''),
      () => { videRecherche(); jourAgenda = r.iso; modeAgenda = 'jour'; vue('agenda'); ouvrirRdv(r); })));
  }
  if (saisies.length) {
    z.appendChild(el('div', 'resultats-titre', 'Prestations'));
    saisies.forEach(r => z.appendChild(ligneResultat(ico('recu'), r.client + ' · ' + (r.caApres !== null ? euros(r.caApres) : r.prixTexte), r.date + ' · ' + r.prestation,
      () => ouvrirModification(r.id))));
  }
  if (!z.children.length) z.appendChild(el('p', 'discret', 'Aucun résultat pour « ' + brut.trim() + ' ».'));
}

/* ---------- Agenda : vue semaine ---------- */
let modeAgenda = lsGet('mode_agenda') === 'semaine' ? 'semaine' : 'jour';
const HEURE_PX = 44;
function choisirModeAgenda(m) { modeAgenda = m; lsSet('mode_agenda', m); afficherAgenda(); }
const heureCourte = h => String(h || '').replace(/^0/, '').replace(':00', ' h').replace(':', ' h ');
function afficherSemaine(lundi) {
  const g = $('grilleSemaine'), semaine = modeAgenda === 'semaine';
  document.querySelectorAll('#modeAgenda button').forEach(b => b.classList.toggle('on', b.dataset.m === modeAgenda));
  g.classList.toggle('cache', !semaine);
  ['titreJour', 'listeRdv', 'btnRdvJour'].forEach(id => $(id).classList.toggle('cache', semaine));
  if (!semaine) return;
  g.innerHTML = '';
  const jours = []; for (let i = 0; i < 7; i++) jours.push(isoPlus(lundi, i));
  const rdvs = agenda().filter(r => jours.includes(r.iso) && r.statut !== 'annulé');
  let hMin = 8, hMax = 20;
  rdvs.forEach(r => { hMin = Math.min(hMin, Math.floor(minutes(r.heure) / 60)); hMax = Math.max(hMax, Math.ceil((minutes(r.heure) + (r.duree || 30)) / 60)); });
  hMax = Math.min(hMax, 24);
  const corps = el('div', 'sem-corps');
  corps.style.height = (hMax - hMin) * HEURE_PX + 'px';
  const heures = el('div', 'sem-heures');
  for (let h = hMin; h < hMax; h++) { const x = el('div', 'sem-h', h + ' h'); x.style.top = (h - hMin) * HEURE_PX + 'px'; heures.appendChild(x); }
  corps.appendChild(heures);
  const maintenantMin = new Date().getHours() * 60 + new Date().getMinutes();
  jours.forEach(iso => {
    const col = el('div', 'sem-col' + (iso === D.aujourdHuiIso ? ' auj' : '') + (iso < D.aujourdHuiIso ? ' passe' : ''));
    col.onclick = e => {
      if (e.target !== col) return;
      const m = hMin * 60 + Math.floor(e.offsetY / HEURE_PX * 2) * 30;
      ouvrirRdv(null, { date: iso, heure: pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60) });
    };
    if (iso === D.aujourdHuiIso && maintenantMin >= hMin * 60 && maintenantMin < hMax * 60) {
      const n = el('div', 'sem-maintenant'); n.style.top = (maintenantMin - hMin * 60) / 60 * HEURE_PX + 'px'; col.appendChild(n);
    }
    rdvs.filter(r => r.iso === iso).forEach(r => {
      const b = el('button', 'sem-rdv' + (r.statut === 'fait' ? ' fait' : ''));
      b.style.top = (minutes(r.heure) - hMin * 60) / 60 * HEURE_PX + 'px';
      b.style.height = Math.max(20, (r.duree || 30) / 60 * HEURE_PX - 2) + 'px';
      b.appendChild(el('b', '', heureCourte(r.heure)));
      b.appendChild(el('span', '', prenom(r.client)));
      b.setAttribute('aria-label', r.client + ', ' + jourLong(r.iso) + ' à ' + heureTexte(r.heure));
      b.onclick = () => ouvrirRdv(r);
      col.appendChild(b);
    });
    corps.appendChild(col);
  });
  g.appendChild(corps);
  const libres = jours.filter(iso => iso >= D.aujourdHuiIso).length;
  g.appendChild(el('p', 'discret', libres ? 'Les zones vides sont libres : touche un créneau pour y ajouter un rendez-vous.' : 'Semaine passée.'));
}

/* ---------- Première ouverture : visite guidée en 3 bulles ---------- */
let visiteLancee = false;
function lancerVisite(force) {
  const cle = 'visite_' + (SALON || 'api');
  if (!force && (visiteLancee || lsGet(cle) || !D || D.journal.length > 30)) return;
  visiteLancee = true;
  if (vueActive !== 'accueil') vue('accueil');
  const etapes = [
    { cible: '#t-nouvelle', titre: 'Enregistre une prestation', texte: 'Touche + après chaque rendez-vous : ' + M('la cliente', 'le client') + ', la prestation, le prix, c\'est fini. Un nouveau prénom crée la fiche tout seul.' },
    { cible: '#t-clientes', titre: M('Tes clientes', 'Tes clients'), texte: 'Fiches, fidélité, anniversaires. Astuce : glisse une fiche vers la droite pour une prestation, vers la gauche pour appeler.' },
    { cible: '.appbar-bouton', titre: 'Réglages et outils', texte: 'Ton logo, ta couleur, tes tarifs, l\'import de tes contacts et le livre des recettes sont rangés ici.' },
  ];
  let i = 0;
  const voile = el('div', 'visite'), trou = el('div', 'visite-trou'), bulle = el('div', 'visite-bulle');
  voile.appendChild(trou); voile.appendChild(bulle); document.body.appendChild(voile);
  const fin = () => { lsSet(cle, '1'); voile.remove(); window.removeEventListener('resize', placer); };
  function placer() {
    const e = etapes[i], c = document.querySelector(e.cible);
    if (!c) return fin();
    const r = c.getBoundingClientRect(), m = 6;
    Object.assign(trou.style, { left: (r.left - m) + 'px', top: (r.top - m) + 'px', width: (r.width + 2 * m) + 'px', height: (r.height + 2 * m) + 'px' });
    bulle.innerHTML = '';
    bulle.appendChild(el('div', 'visite-etape', (i + 1) + ' / ' + etapes.length));
    bulle.appendChild(el('b', '', e.titre));
    bulle.appendChild(el('p', '', e.texte));
    const act = el('div', 'visite-actions');
    const passer = el('button', 'lien', 'Passer'); passer.onclick = fin;
    const suiv = el('button', 'visite-suivant', i < etapes.length - 1 ? 'Suivant' : 'C\'est parti !');
    suiv.onclick = () => { i++; if (i >= etapes.length) fin(); else placer(); };
    act.appendChild(i < etapes.length - 1 ? passer : el('span')); act.appendChild(suiv); bulle.appendChild(act);
    const enBas = r.top > window.innerHeight / 2;
    bulle.style.top = enBas ? '' : (r.bottom + 16) + 'px';
    bulle.style.bottom = enBas ? (window.innerHeight - r.top + 16) + 'px' : '';
  }
  window.addEventListener('resize', placer);
  placer();
}

/* ---------- Transitions entre écrans ---------- */
const PROFONDEUR = { plus: 1, fiche: 1, recettes: 1, stats: 1, reglages: 2, import: 2, abonnement: 2, tarifs: 2, offres: 2, achats: 2 };
const ORDRE_ONGLETS = ['accueil', 'agenda', 'nouvelle', 'clientes', 'bilan'];
function sensTransition(de, vers) {
  if (de === vers) return '';
  const a = PROFONDEUR[de] || 0, b = PROFONDEUR[vers] || 0;
  if (b > a) return 'droite';
  if (b < a) return 'gauche';
  const i = ORDRE_ONGLETS.indexOf(de), j = ORDRE_ONGLETS.indexOf(vers);
  if (i >= 0 && j >= 0) return j > i ? 'droite' : 'gauche';
  return '';
}
function animerEcran(s, sens) {
  s.classList.remove('va-droite', 'va-gauche');
  if (!sens) return;
  void s.offsetWidth;
  s.classList.add('va-' + sens);
}

/* ---------- Fenêtres du bas : glisser vers le bas pour fermer ---------- */
function feuilleGlissable(idModale, fermer) {
  const f = $(idModale).querySelector('.feuille');
  let y0 = null, dy = 0;
  f.addEventListener('touchstart', e => {
    const surPoignee = !!e.target.closest('.feuille-poignee');
    if ((!surPoignee && f.scrollTop > 0) || e.target.closest('input, select, textarea')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; f.style.transition = 'none';
  }, { passive: true });
  f.addEventListener('touchmove', e => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    f.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
  }, { passive: true });
  f.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null; f.style.transition = '';
    if (dy > 110) { f.style.transform = 'translateY(100%)'; vibrer(8); setTimeout(() => { fermer(); f.style.transform = ''; }, 200); }
    else f.style.transform = '';
  });
}
feuilleGlissable('modale', fermerModale);
feuilleGlissable('modaleRdv', fermerRdv);

/* ---------- En-tête qui rétrécit en faisant défiler ---------- */
let enteteCompact = false;
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if (!enteteCompact && y > 60) { enteteCompact = true; document.body.classList.add('entete-compact'); }
  else if (enteteCompact && y < 8) { enteteCompact = false; document.body.classList.remove('entete-compact'); }
}, { passive: true });

/* ---------- Démarrage ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* facultatif */ });
enTeteDepuisCache(); // en-tête du salon dès l'ouverture (dernière visite)
charger();
