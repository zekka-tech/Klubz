/**
 * Klubz - Geocoding & Routing Integration (Mapbox)
 *
 * Workers-compatible HTTP-based geocoding, reverse geocoding, and route calculation.
 */

import type { Bindings, GeocodingResult, RouteResult } from '../types';

export class GeoService {
  private accessToken: string;
  private baseUrl = 'https://api.mapbox.com';

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Forward geocode: address string → coordinates.
   */
  async geocode(query: string, options?: {
    country?: string;
    proximity?: { lat: number; lng: number };
    limit?: number;
  }): Promise<GeocodingResult[]> {
    const params = new URLSearchParams({
      access_token: this.accessToken,
      limit: (options?.limit ?? 5).toString(),
      language: 'en',
    });
    if (options?.country) params.set('country', options.country);
    if (options?.proximity) {
      params.set('proximity', `${options.proximity.lng},${options.proximity.lat}`);
    }

    const url = `${this.baseUrl}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding failed: ${res.statusText}`);

    const data = await res.json() as {
      features: Array<{
        center: [number, number];
        place_name: string;
        id: string;
        relevance: number;
      }>;
    };

    return data.features.map((f) => ({
      lng: f.center[0],
      lat: f.center[1],
      address: f.place_name,
      placeId: f.id,
      confidence: f.relevance,
    }));
  }

  /**
   * Reverse geocode: coordinates → address.
   */
  async reverseGeocode(lat: number, lng: number): Promise<GeocodingResult | null> {
    const url = `${this.baseUrl}/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${this.accessToken}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json() as {
      features: Array<{
        center: [number, number];
        place_name: string;
        id: string;
        relevance: number;
      }>;
    };

    if (!data.features.length) return null;
    const f = data.features[0];
    return {
      lat: f.center[1],
      lng: f.center[0],
      address: f.place_name,
      placeId: f.id,
      confidence: f.relevance,
    };
  }

  /**
   * Calculate driving route between two points.
   * Returns distance, duration, and encoded polyline.
   */
  async getRoute(
    origin: { lat: number; lng: number },
    destination: { lat: number; lng: number },
    waypoints?: Array<{ lat: number; lng: number }>,
  ): Promise<RouteResult> {
    const coords = [
      `${origin.lng},${origin.lat}`,
      ...(waypoints?.map((w) => `${w.lng},${w.lat}`) ?? []),
      `${destination.lng},${destination.lat}`,
    ].join(';');

    const params = new URLSearchParams({
      access_token: this.accessToken,
      geometries: 'polyline6',
      overview: 'full',
      steps: 'false',
    });

    const url = `${this.baseUrl}/directions/v5/mapbox/driving/${coords}?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Routing failed: ${res.statusText}`);

    const data = await res.json() as {
      routes: Array<{
        distance: number;
        duration: number;
        geometry: string;
        legs: Array<{
          steps: Array<{
            maneuver: { location: [number, number] };
          }>;
        }>;
      }>;
    };

    if (!data.routes.length) {
      throw new Error('No route found');
    }

    const route = data.routes[0];
    const routeWaypoints = route.legs.flatMap((leg) =>
      leg.steps.map((step) => ({
        lat: step.maneuver.location[1],
        lng: step.maneuver.location[0],
      }))
    );

    return {
      distanceKm: Math.round((route.distance / 1000) * 100) / 100,
      durationMinutes: Math.round((route.duration / 60) * 10) / 10,
      polyline: route.geometry,
      waypoints: routeWaypoints,
    };
  }

  /**
   * Calculate estimated trip price based on distance and duration.
   */
  calculatePrice(distanceKm: number, durationMinutes: number): {
    amount: number;
    currency: string;
    breakdown: { baseFare: number; distanceFare: number; timeFare: number; serviceFee: number };
  } {
    const baseFare = 15.00;        // ZAR base fare
    const perKm = 2.50;           // ZAR per km
    const perMinute = 0.75;       // ZAR per minute
    const serviceFeeRate = 0.15;  // 15% service fee

    const distanceFare = Math.round(distanceKm * perKm * 100) / 100;
    const timeFare = Math.round(durationMinutes * perMinute * 100) / 100;
    const subtotal = baseFare + distanceFare + timeFare;
    const serviceFee = Math.round(subtotal * serviceFeeRate * 100) / 100;
    const total = Math.round((subtotal + serviceFee) * 100) / 100;

    return {
      amount: total,
      currency: 'ZAR',
      breakdown: { baseFare, distanceFare, timeFare, serviceFee },
    };
  }
}

/**
 * Factory function to get a GeoService from environment bindings.
 */
export function getGeoService(env: Bindings): GeoService | null {
  if (!env.MAPBOX_ACCESS_TOKEN) return null;
  return new GeoService(env.MAPBOX_ACCESS_TOKEN);
}
