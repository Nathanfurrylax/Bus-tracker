const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const csv = require('csv-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// URL officielle du jeu de données GTFS Sankéo sur transport.data.gouv.fr
const SANKEYO_GTFS_URL = 'https://transport.data.gouv.fr/datasets/gtfs-sankeo/download';
const GTFS_DIR = path.join(__dirname, 'gtfs_data');
const ZIP_PATH = path.join(__dirname, 'sankeo.zip');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'TA_CLE_API';

// Cache en mémoire pour les données GTFS
let gtfsCache = {
    stops: new Map(),       // stop_id -> { id, name, lat, lng }
    trips: new Map(),       // trip_id -> { tripId, routeId, serviceId, headsign }
    stopTimes: new Map(),   // trip_id -> array of { stopId, sequence, arrivalTime, departureTime }
    routes: new Map()       // route_id -> { id, shortName, longName, color }
};

/**
 * 1. Télécharge et extrait le fichier GTFS zip officiel de Sankéo
 */
async function downloadAndExtractGTFS() {
    console.log('📥 Téléchargement du fichier GTFS officiel Sankéo...');
    try {
        const response = await axios({
            method: 'get',
            url: SANKEYO_GTFS_URL,
            responseType: 'stream'
        });

        if (!fs.existsSync(GTFS_DIR)) {
            fs.mkdirSync(GTFS_DIR, { recursive: true });
        }

        const writer = fs.createWriteStream(ZIP_PATH);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log('📦 Extraction du ZIP GTFS...');
        await fs.createReadStream(ZIP_PATH)
            .pipe(unzipper.Extract({ path: GTFS_DIR }))
            .promise();

        console.log('✅ Archive extraite. Début du parsing GTFS...');
        await parseGTFSData();
    } catch (err) {
        console.error('❌ Erreur lors de la récupération du GTFS :', err.message);
    }
}

/**
 * Helper pour lire un fichier CSV GTFS
 */
function readCSV(filename, onRow) {
    const filePath = path.join(GTFS_DIR, filename);
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            console.warn(`Fichier introuvable : ${filename}`);
            return resolve();
        }
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', onRow)
            .on('end', resolve)
            .on('error', reject);
    });
}

/**
 * 2. Parse les données des fichiers CSV dans le cache mémoire
 */
async function parseGTFSData() {
    gtfsCache.stops.clear();
    gtfsCache.trips.clear();
    gtfsCache.stopTimes.clear();
    gtfsCache.routes.clear();

    // Parse stops.txt
    await readCSV('stops.txt', (row) => {
        gtfsCache.stops.set(row.stop_id, {
            id: row.stop_id,
            name: row.stop_name,
            lat: parseFloat(row.stop_lat),
            lng: parseFloat(row.stop_lon)
        });
    });

    // Parse routes.txt
    await readCSV('routes.txt', (row) => {
        gtfsCache.routes.set(row.route_id, {
            id: row.route_id,
            shortName: row.route_short_name,
            longName: row.route_long_name,
            color: row.route_color ? `#${row.route_color}` : '#d71921'
        });
    });

    // Parse trips.txt
    await readCSV('trips.txt', (row) => {
        gtfsCache.trips.set(row.trip_id, {
            tripId: row.trip_id,
            routeId: row.route_id,
            serviceId: row.service_id,
            headsign: row.trip_headsign
        });
    });

    // Parse stop_times.txt
    await readCSV('stop_times.txt', (row) => {
        const tripId = row.trip_id;
        if (!gtfsCache.stopTimes.has(tripId)) {
            gtfsCache.stopTimes.set(tripId, []);
        }
        gtfsCache.stopTimes.get(tripId).push({
            stopId: row.stop_id,
            sequence: parseInt(row.stop_sequence, 10),
            arrivalTime: row.arrival_time,
            departureTime: row.departure_time
        });
    });

    // Trier les horaires d'arrêts par ordre de passage
    for (const [tripId, times] of gtfsCache.stopTimes.entries()) {
        times.sort((a, b) => a.sequence - b.sequence);
    }

    console.log(`✨ Données prêtes ! ${gtfsCache.stops.size} arrêts, ${gtfsCache.routes.size} lignes répertoriées.`);
}

/**
 * Convertit "HH:MM:SS" en secondes depuis minuit
 */
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

/**
 * Interroge l'API de trafic (Google Maps Distance Matrix)
 */
async function getTrafficDuration(origin, destination) {
    if (GOOGLE_MAPS_API_KEY === 'TA_CLE_API') {
        return null;
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&departure_time=now&key=${GOOGLE_MAPS_API_KEY}`;
        const response = await axios.get(url);
        const element = response.data.rows[0].elements[0];

        if (element && element.status === 'OK') {
            return {
                durationTheoretical: element.duration.value,
                durationTraffic: element.duration_in_traffic ? element.duration_in_traffic.value : element.duration.value
            };
        }
    } catch (error) {
        console.error("Erreur API Trafic:", error.message);
    }
    return null;
}

/**
 * API Route: Liste des lignes Sankéo
 */
app.get('/api/routes', (req, res) => {
    res.json(Array.from(gtfsCache.routes.values()));
});

/**
 * API Route: Estimation de la position du bus en temps réel
 */
app.get('/api/estimate-bus', async (req, res) => {
    const requestedRouteId = req.query.routeId;
    
    const now = new Date();
    const currentSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    let activeTrip = null;

    // Rechercher une course GTFS correspondant à l'heure courante
    for (const [tripId, times] of gtfsCache.stopTimes.entries()) {
        const trip = gtfsCache.trips.get(tripId);
        if (requestedRouteId && trip && trip.routeId !== requestedRouteId) continue;

        const startSec = timeToSeconds(times[0].departureTime);
        const endSec = timeToSeconds(times[times.length - 1].arrivalTime);

        if (currentSec >= startSec && currentSec <= endSec) {
            activeTrip = { trip, times };
            break;
        }
    }

    // Fallback de test si aucun bus ne roule actuellement à la seconde près
    if (!activeTrip && gtfsCache.stopTimes.size > 0) {
        const firstTripId = Array.from(gtfsCache.stopTimes.keys())[0];
        activeTrip = {
            trip: gtfsCache.trips.get(firstTripId),
            times: gtfsCache.stopTimes.get(firstTripId)
        };
    }

    if (!activeTrip || !activeTrip.times || activeTrip.times.length < 2) {
        return res.status(404).json({ error: "Aucun bus ou trajet trouvé pour le moment." });
    }

    const { trip, times } = activeTrip;
    const route = gtfsCache.routes.get(trip.routeId);

    // Identifier les 2 arrêts encadrant le bus
    let index = 0;
    for (let i = 0; i < times.length - 1; i++) {
        const dep = timeToSeconds(times[i].departureTime);
        const arr = timeToSeconds(times[i + 1].arrivalTime);
        if (currentSec >= dep && currentSec <= arr) {
            index = i;
            break;
        }
    }

    const stopAData = times[index];
    const stopBData = times[Math.min(index + 1, times.length - 1)];

    const stopA = gtfsCache.stops.get(stopAData.stopId);
    const stopB = gtfsCache.stops.get(stopBData.stopId);

    const timeA = timeToSeconds(stopAData.departureTime);
    const timeB = timeToSeconds(stopBData.arrivalTime);
    const theoreticalDuration = Math.max(timeB - timeA, 1);
    const elapsedTime = Math.max(0, currentSec - timeA);

    // Prise en compte du trafic
    let trafficRatio = 1.0;
    if (stopA && stopB && stopA.id !== stopB.id) {
        const trafficData = await getTrafficDuration(stopA, stopB);
        if (trafficData && trafficData.durationTraffic > 0) {
            trafficRatio = trafficData.durationTheoretical / trafficData.durationTraffic;
        }
    }

    // Calcul d'interpolation GPS ajustée
    let progress = (elapsedTime / theoreticalDuration) * trafficRatio;
    progress = Math.min(Math.max(progress, 0), 1);

    const estimatedLat = stopA.lat + (stopB.lat - stopA.lat) * progress;
    const estimatedLng = stopA.lng + (stopB.lng - stopA.lng) * progress;

    res.json({
        tripHeadsign: trip.headsign,
        routeName: route ? `${route.shortName} - ${route.longName}` : "Ligne Sankéo",
        routeColor: route ? route.color : "#d71921",
        stopA,
        stopB,
        estimatedPosition: { lat: estimatedLat, lng: estimatedLng },
        progress: (progress * 100).toFixed(1),
        trafficRatio: trafficRatio.toFixed(2),
        schedule: {
            departureA: stopAData.departureTime,
            arrivalB: stopBData.arrivalTime
        }
    });
});

// Lancement et téléchargement automatique
app.listen(PORT, async () => {
    console.log(`🚀 Serveur actif sur http://localhost:${PORT}`);
    await downloadAndExtractGTFS();
});
