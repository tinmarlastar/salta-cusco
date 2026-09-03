/* Tests de la bascule d'une journée à l'autre, à 20 h locale.

   Ce mécanisme tourne SEUL pendant quinze jours, à l'autre bout du monde, sans
   que personne puisse le réparer depuis la piste. Il traverse quatre fuseaux et
   un changement d'heure. C'est exactement le genre de code qu'il faut éprouver
   avant de partir plutôt que de le regarder se tromper d'un jour. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FUSEAU_PAR_JOUR, fuseauDuJour, instantLocal, calculerPositionAuto, dateDuJourVoyage,
} from '../lib/position.js';

/* Un instant réel : 20 h à Salta le 29 août 2026, c'est 23 h UTC le même jour
   (l'Argentine est à UTC-3 toute l'année, sans heure d'été). */
const VINGT_H_SALTA_29 = new Date('2026-08-29T23:00:00Z');

// ------------------------------------------------------- l'heure locale

test('instantLocal rend 20 h en Argentine, qui est à UTC-3', () => {
  assert.equal(
    instantLocal('2026-08-29', 20, 'America/Argentina/Salta').toISOString(),
    '2026-08-29T23:00:00.000Z',
  );
});

test('instantLocal rend 20 h au Pérou, qui est à UTC-5', () => {
  assert.equal(
    instantLocal('2026-09-07', 20, 'America/Lima').toISOString(),
    '2026-09-08T01:00:00.000Z',
  );
});

/* Le Chili passe à l'heure d'été le premier dimanche de septembre : UTC-4 avant,
   UTC-3 après. Un décalage écrit en dur se serait trompé d'une heure sur la
   moitié du voyage — d'où le passage par les fuseaux nommés plutôt que par des
   offsets. */
test('instantLocal suit le changement d\'heure chilien', () => {
  assert.equal(
    instantLocal('2026-08-31', 20, 'America/Santiago').toISOString(),
    '2026-09-01T00:00:00.000Z', // UTC-4
  );
  assert.equal(
    instantLocal('2026-09-10', 20, 'America/Santiago').toISOString(),
    '2026-09-10T23:00:00.000Z', // UTC-3, heure d'été
  );
});

// -------------------------------------------------- la bascule elle-même

test('la journée ne bascule pas avant 20 h locale', () => {
  const uneMinuteAvant = new Date(VINGT_H_SALTA_29.getTime() - 60_000);
  assert.equal(calculerPositionAuto({ depart: '2026-08-29', maintenant: uneMinuteAvant }), null);
});

test('la journée bascule à 20 h locale, pile', () => {
  assert.equal(calculerPositionAuto({ depart: '2026-08-29', maintenant: VINGT_H_SALTA_29 }), 2);
});

/* Le point de toute la reprise : pendant la journée de route, la frise annonce
   encore le départ. Elle ne nomme la ville d'arrivée qu'une fois qu'on y est —
   à 20 h, le soir même. Sous l'ancienne règle (minuit à Paris) elle nommait
   Humahuaca dès la veille au soir, alors que personne n'avait bougé. */
test('le matin du départ, on n\'est pas encore arrivé', () => {
  const matinDuDepart = new Date('2026-08-29T13:00:00Z'); // 10 h à Salta
  assert.equal(calculerPositionAuto({ depart: '2026-08-29', maintenant: matinDuDepart }), null);
});

test('la veille au soir, rien ne bouge encore', () => {
  const veilleAuSoir = new Date('2026-08-28T23:30:00Z'); // 20 h 30 à Salta, la veille
  assert.equal(calculerPositionAuto({ depart: '2026-08-29', maintenant: veilleAuSoir }), null);
});

/* Chaque bascule se fait à l'heure de la ville où l'on ARRIVE ce soir-là, et
   ces villes changent de fuseau en cours de route. J5 finit en Bolivie
   (UTC-4) : 20 h là-bas, c'est minuit UTC le lendemain. */
test('la bascule suit le fuseau de la ville d\'arrivée du jour', () => {
  const commun = { depart: '2026-08-29' };
  // J5 = Laguna Colorada, Bolivie, le 1er septembre.
  const avant = new Date('2026-09-01T23:59:00Z');
  const apres = new Date('2026-09-02T00:00:00Z');
  assert.equal(calculerPositionAuto({ ...commun, maintenant: avant }), 4);
  assert.equal(calculerPositionAuto({ ...commun, maintenant: apres }), 5);
});

test('la bascule vers le Pérou se fait bien deux heures après l\'Argentine', () => {
  // J11 = Llachón, Pérou (UTC-5), le 7 septembre : 20 h locale = 1 h UTC le 8.
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', maintenant: new Date('2026-09-08T00:59:00Z'),
  }), 10);
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', maintenant: new Date('2026-09-08T01:00:00Z'),
  }), 11);
});

test('le voyage plafonne à J15 et n\'en bouge plus', () => {
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', maintenant: new Date('2026-10-30T12:00:00Z'),
  }), 15);
});

test('J1 n\'est jamais rendu', () => {
  for (const quand of ['2026-08-20', '2026-08-28', '2026-08-29', '2026-09-05']) {
    assert.notEqual(calculerPositionAuto({
      depart: '2026-08-29', maintenant: new Date(`${quand}T12:00:00Z`),
    }), 1, quand);
  }
});

// ------------------------------------------------------------ décalage

test('un jour de retard repousse la bascule de vingt-quatre heures', () => {
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', decalage: -1, maintenant: VINGT_H_SALTA_29,
  }), null);
  const lendemain = new Date(VINGT_H_SALTA_29.getTime() + 24 * 3600_000);
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', decalage: -1, maintenant: lendemain,
  }), 2);
});

test('un jour d\'avance avance la bascule d\'autant', () => {
  const veille = new Date(VINGT_H_SALTA_29.getTime() - 24 * 3600_000);
  assert.equal(calculerPositionAuto({
    depart: '2026-08-29', decalage: 1, maintenant: veille,
  }), 2);
});

// ------------------------------------------------ garde contre la dérive

/* Le service ne lit pas `data/etapes.json` — c'est un fichier du site. Sa table
   de fuseaux recopie donc l'itinéraire, et une étape déplacée d'un pays à
   l'autre la laisserait mentir en silence. Ce test compare les deux : il est le
   seul lien entre le contenu éditorial et le calcul du service. */
test('la table des fuseaux suit les pays d\'arrivée de data/etapes.json', () => {
  const brut = JSON.parse(readFileSync(new URL('../../data/etapes.json', import.meta.url), 'utf8'));
  const etapes = brut.etapes || brut;
  const attendu = {
    AR: 'America/Argentina/Salta',
    CL: 'America/Santiago',
    BO: 'America/La_Paz',
    PE: 'America/Lima',
  };

  for (const etape of etapes) {
    if (etape.jour < 2) continue;
    const paysArrivee = etape.pays[etape.pays.length - 1];
    assert.ok(attendu[paysArrivee], `pays inconnu de la table : ${paysArrivee} (J${etape.jour})`);
    assert.equal(FUSEAU_PAR_JOUR[etape.jour], attendu[paysArrivee],
      `J${etape.jour} arrive en ${paysArrivee} (${etape.arrivee.nom})`);
  }
});

test('chaque journée roulée a son fuseau', () => {
  for (let jour = 2; jour <= 15; jour += 1) {
    assert.ok(FUSEAU_PAR_JOUR[jour], `J${jour} sans fuseau`);
  }
});

// ---------------------------------------------------- l'aller-retour

/* `dateDuJourVoyage` sert à annoncer la date du départ : elle doit désigner le
   jour où `calculerPositionAuto` bascule, sans quoi la frise annoncerait une
   date et changerait un autre jour. */
test('la date annoncée est bien celle du soir où la journée bascule', () => {
  for (const decalage of [-2, 0, 2]) {
    for (let jour = 2; jour <= 15; jour += 1) {
      const date = dateDuJourVoyage({ depart: '2026-08-29', decalage, jour });
      const bascule = instantLocal(date, 20, FUSEAU_PAR_JOUR[jour]);
      assert.equal(
        calculerPositionAuto({ depart: '2026-08-29', decalage, maintenant: bascule }),
        jour,
        `décalage ${decalage}, jour ${jour}`,
      );
    }
  }
});

// ------------------------------------------------------ le prévisionnel

/* Le calendrier des bascules, tel que la page d'administration l'affiche.

   Il rend des INSTANTS absolus et le nom du fuseau, jamais des heures déjà
   écrites : c'est le service qui sait QUAND une journée bascule, et le
   navigateur qui sait l'écrire — en heure locale, en heure française, ou dans
   les deux. Rendre « 20h00 » tout fait aurait obligé le service à choisir un
   fuseau d'affichage, ce qui n'est pas son affaire. */
test('calendrierDesBascules couvre les quatorze journées roulées', async () => {
  const { calendrierDesBascules } = await import('../lib/position.js');
  const cal = calendrierDesBascules({ depart: '2026-08-29', decalage: 0 });
  assert.equal(cal.length, 14);
  assert.equal(cal[0].jour, 2);
  assert.equal(cal[cal.length - 1].jour, 15);
});

test('chaque entrée porte son instant de bascule et son fuseau', async () => {
  const { calendrierDesBascules } = await import('../lib/position.js');
  const [premiere] = calendrierDesBascules({ depart: '2026-08-29', decalage: 0 });
  assert.equal(premiere.date, '2026-08-29');
  assert.equal(premiere.fuseau, 'America/Argentina/Salta');
  assert.equal(premiere.bascule, '2026-08-29T23:00:00.000Z'); // 20 h à Salta
});

/* Le calendrier et le calcul de la position doivent dire la même chose : sinon
   la page annoncerait une bascule à une heure, et la frise changerait à une
   autre. */
test('chaque bascule annoncée est bien celle que la position applique', async () => {
  const { calendrierDesBascules } = await import('../lib/position.js');
  for (const decalage of [-1, 0, 3]) {
    for (const entree of calendrierDesBascules({ depart: '2026-08-29', decalage })) {
      const instant = new Date(entree.bascule);
      assert.equal(
        calculerPositionAuto({ depart: '2026-08-29', decalage, maintenant: instant }),
        entree.jour,
        `décalage ${decalage}, J${entree.jour}`,
      );
    }
  }
});

test('le calendrier est vide sans date de départ', async () => {
  const { calendrierDesBascules } = await import('../lib/position.js');
  assert.deepEqual(calendrierDesBascules({ depart: null, decalage: 0 }), []);
});

// ------------------------------------------- le fuseau annoncé au site

/* Le site affiche l'heure qu'il est chez les motards sous « Nous sommes ici »,
   et reçoit le fuseau avec la position plutôt que de le déduire lui-même :
   c'est ici qu'est la table, et un test la compare déjà à `data/etapes.json`.
   Une troisième copie côté site aurait été la seule que rien ne surveille. */
test('fuseauDuJour rend le fuseau de la ville où l\'on dort ce soir-là', () => {
  assert.equal(fuseauDuJour(7), 'America/La_Paz');
  assert.equal(fuseauDuJour(12), 'America/Lima');
  assert.equal(fuseauDuJour(5), 'America/Santiago');
});

/* J1 est le rassemblement à Salta, pas une journée roulée : la table des
   bascules commence à J2, mais les motards sont bien quelque part ce jour-là,
   et la position manuelle permet de poser J1. Sans ce cas, la seule journée où
   tout le monde regarde le site — la veille du départ — serait la seule sans
   heure. */
test('fuseauDuJour couvre J1, absent de la table des bascules', () => {
  assert.equal(fuseauDuJour(1), 'America/Argentina/Salta');
});

test('fuseauDuJour rend null quand la journée est inconnue ou absente', () => {
  assert.equal(fuseauDuJour(null), null);
  assert.equal(fuseauDuJour(0), null);
  assert.equal(fuseauDuJour(16), null);
  assert.equal(fuseauDuJour('sept'), null);
});
