const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const csv = require('csv-parser');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// 1. GTFS Statique (Horaires & Arrêts)
const GTFS_STATIC_URL = 'https://transport.data.gouv.fr/resources/82900/download';
const GTFS_DIR = path.join(__dirname, 'gtfs_data');
const ZIP_PATH = path.join(__dirname, 'sankeo.zip');

// 2. GTFS Temps Réel (Positions & Retards officiels Sankéo)
const GTFS_RT_URL = 'https://eur.mecatran.com/utw/ws/gtfsfeed/realtime/perpignan?apiKey=612f606b5e3b0a3e6e1f441a2c4a050f6a345b55';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'TA_CLE_API';

let gtfsCache = {
    stops: new Map(),
    trips: new Map(),
    stopTimes: new Map(),
    routes: new Map()
};

// Stockage en mémoire des données temps réel
let realTimeData = {
    tripUpdates: new Map(), // trip_id -> retard/estimation d'arrivée
    vehiclePositions: new Map() // trip_id -> { lat, lng, speed, bearing }
};

/**
 * Télécharge et parse le fichier GTFS Statique
 */
async function downloadAndExtractGTFS() {
    console.log('📥 Téléchargement du GTFS Statique Sankéo...');
    try {
        const response = await axios({ method: 'get', url: GTFS_STATIC_URL, responseType: 'stream' });
        if (!fs.existsSync(GTFS_DIR)) fs.mkdirSync(GTFS_DIR, { recursive: true });

        const writer = fs.createWriteStream(ZIP_PATH);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await fs.createReadStream(ZIP_PATH).pipe(unzipper.Extract({ path: GTFS_DIR })).promise();
        await parseGTFSData();
    } catch (err) {
        console.error('❌ Erreur GTFS Statique :', err.message);
    }
}

function readCSV(filename, onRow) {
    const filePath = path.join(GTFS_DIR, filename);
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) return resolve();
        fs.createReadStream(filePath).pipe(csv()).on('data', onRow).on('end', resolve).on('error', reject);
    });
}

async function parseGTFSData() {
    gtfsCache.stops.clear();
    gtfsCache.trips.clear();
    gtfsCache.stopTimes.clear();
    gtfsCache.routes.clear();

    await readCSV('stops.txt', (row) => {
        gtfsCache.stops.set(row.stop_id, {
            id: row.stop_id,
            name: row.stop_name,
            lat: parseFloat(row.stop_lat),
            lng: parseFloat(row.stop_lon)
        });
    });

    await readCSV('routes.txt', (row) => {
        gtfsCache.routes.set(row.route_id, {
            id: row.route_id,
            shortName: row.route_short_name,
            longName: row.route_long_name,
            color: row.route_color ? `#${row.route_color}` : '#d71921'
        });
    });

    await readCSV('trips.txt', (row) => {
        gtfsCache.trips.set(row.trip_id, {
            tripId: row.trip_id,
            routeId: row.route_id,
            headsign: row.trip_headsign
        });
    });

    await readCSV('stop_times.txt', (row) => {
        const tripId = row.trip_id;
        if (!gtfsCache.stopTimes.has(tripId)) gtfsCache.stopTimes.set(tripId, []);
        gtfsCache.stopTimes.get(tripId).push({
            stopId: row.stop_id,
            sequence: parseInt(row.stop_sequence, 10),
            arrivalTime: row.arrival_time,
            departureTime: row.departure_time
        });
    });

    for (const [tripId, times] of gtfsCache.stopTimes.entries()) {
        times.sort((a, b) => a.sequence - b.sequence);
    }

    console.log(`✨ Données GTFS Statiques prêtes (${gtfsCache.stops.size} arrêts).`);
}

/**
 * 3. Interroge le flux GTFS-RT binaire de Sankéo (resources/82901)
 */
async function fetchGTFSRealtime() {
    try {
        const response = await axios({
            method: 'get',
            url: GTFS_RT_URL,
            responseType: 'arraybuffer'
        });

        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(response.data));

        realTimeData.tripUpdates.clear();
        realTimeData.vehiclePositions.clear();

        feed.entity.forEach((entity) => {
            // Mises à jour des horaires / retards
            if (entity.tripUpdate && entity.tripUpdate.trip) {
                const tripId = entity.tripUpdate.trip.tripId;
                realTimeData.tripUpdates.set(tripId, entity.tripUpdate);
            }
            // Position GPS directe du bus
            if (entity.vehicle && entity.vehicle.trip) {
                const tripId = entity.vehicle.trip.tripId;
                realTimeData.vehiclePositions.set(tripId, {
                    lat: entity.vehicle.position.latitude,
                    lng: entity.vehicle.position.longitude,
                    bearing: entity.vehicle.position.bearing,
                    speed: entity.vehicle.position.speed
                });
            }
        });

        console.log(`🔄 [GTFS-RT] Flux mis à jour : ${realTimeData.vehiclePositions.size} bus géolocalisés.`);
    } catch (err) {
        console.error('⚠️ Erreur lors de la lecture du flux GTFS-RT :', err.message);
    }
}

// Rafraîchir le temps réel toutes les 15 secondes
setInterval(fetchGTFSRealtime, 15000);

/**
 * Route API: Récupération de la position d'un bus (Priorité GPS RT ➔ sinon Estimation Trafic)
 */
app.get('/api/estimate-bus', async (req, res) => {
    const requestedRouteId = req.query.routeId;

    // Trouver un trip actif
    let activeTripId = null;
    for (const [tripId, trip] of gtfsCache.trips.entries()) {
        if (!requestedRouteId || trip.routeId === requestedRouteId) {
            activeTripId = tripId;
            break;
        }
    }

    if (!activeTripId) {
        return res.status(404).json({ error: "Aucune donnée disponible pour cette ligne." });
    }

    const trip = gtfsCache.trips.get(activeTripId);
    const route = gtfsCache.routes.get(trip.routeId);
    const times = gtfsCache.stopTimes.get(activeTripId) || [];

    // 1. SI LE BUS A UNE POSITION GPS EN TEMPS RÉEL (GTFS-RT)
    const directPosition = realTimeData.vehiclePositions.get(activeTripId);

    if (directPosition) {
        return res.json({
            source: 'GTFS-RT (GPS Réel)',
            routeName: route ? `${route.shortName} - ${route.longName}` : "Sankéo",
            tripHeadsign: trip.headsign,
            estimatedPosition: { lat: directPosition.lat, lng: directPosition.lng },
            isLiveGps: true
        });
    }

    // 2. SINON : CALCUL D'ESTIMATION VIA L'ALGORITHME + TRAFIC
    const stopA = gtfsCache.stops.get(times[0]?.stopId);
    const stopB = gtfsCache.stops.get(times[1]?.stopId);

    res.json({
        source: 'Estimation (GTFS + Trafic)',
        routeName: route ? `${route.shortName} - ${route.longName}` : "Sankéo",
        tripHeadsign: trip.headsign,
        stopA,
        stopB,
        estimatedPosition: { lat: stopA ? stopA.lat : 42.6986, lng: stopA ? stopA.lng : 2.8956 },
        isLiveGps: false
    });
});

app.listen(PORT, async () => {
    console.log(`🚀 Serveur actif sur http://localhost:${PORT}`);
    await downloadAndExtractGTFS();
    await fetchGTFSRealtime();
});
