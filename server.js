const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Clé API Google Distance Matrix (ou autre service de routing)
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'TA_CLE_API';

/**
 * Calcule la durée réelle d'un trajet en tenant compte du trafic
 */
async function getTrafficDuration(origin, destination) {
    if (GOOGLE_MAPS_API_KEY === 'TA_CLE_API') {
        // Simulation si pas de clé API fournie
        return null;
    }
    
    try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${destination.lat},${destination.lng}&departure_time=now&key=${GOOGLE_MAPS_API_KEY}`;
        const response = await axios.get(url);
        const element = response.data.rows[0].elements[0];
        
        return {
            durationTheoretical: element.duration.value, // en secondes
            durationTraffic: element.duration_in_traffic ? element.duration_in_traffic.value : element.duration.value
        };
    } catch (error) {
        console.error("Erreur API Trafic:", error.message);
        return null;
    }
}

/**
 * Route d'estimation de la position du bus
 */
app.get('/api/estimate-bus', async (req, res) => {
    // EXEMPLE SIMULÉ : Trajet entre deux arrêts à Perpignan
    // Remplace par tes données extraites du fichier GTFS Sankéo
    const stopA = { lat: 42.6986, lng: 2.8956, name: "Gare TGV" };
    const stopB = { lat: 42.6996, lng: 2.8872, name: "Catalogne" };
    
    const theoreticalDepartureSec = 0;   // Départ à T+0
    const theoreticalArrivalSec = 300;   // Arrivée prévue à T+5 min (300 sec)
    const theoreticalDuration = theoreticalArrivalSec - theoreticalDepartureSec;
    
    // Temps écoulé depuis le départ théorique (ex: 2 min / 120 sec)
    const elapsedTimeSec = 120; 

    // Interrogation du trafic réel
    const trafficData = await getTrafficDuration(stopA, stopB);
    
    let ratio = 1.0;
    if (trafficData && trafficData.durationTraffic > 0) {
        // Si trafic dense, le bus va moins vite -> le ratio ralentit la progression
        ratio = trafficData.durationTheoretical / trafficData.durationTraffic;
    }

    // Calcul de l'avancement théorique ajusté au trafic
    let progress = (elapsedTimeSec / theoreticalDuration) * ratio;
    progress = Math.min(Math.max(progress, 0), 1); // Borner entre 0 et 1

    // Interpolation linéaire de la position GPS (Lat/Lng)
    const estimatedLat = stopA.lat + (stopB.lat - stopA.lat) * progress;
    const estimatedLng = stopA.lng + (stopB.lng - stopA.lng) * progress;

    res.json({
        estimatedPosition: { lat: estimatedLat, lng: estimatedLng },
        stopA,
        stopB,
        progress: (progress * 100).toFixed(1),
        trafficRatio: ratio.toFixed(2)
    });
});

app.listen(PORT, () => {
    console.log(`Serveur prêt sur http://localhost:${PORT}`);
});
