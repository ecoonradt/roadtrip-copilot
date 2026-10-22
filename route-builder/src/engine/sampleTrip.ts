import type { ParsedTrip } from './itineraryParser';

const SAMPLE_TIMEZONE = 'America/Phoenix';

/**
 * Builds a brand-new single-day, ad-hoc (relative) sample road trip from Phoenix to Flagstaff.
 *
 * - Single day only (`isMultiDay: false`) with `isAdHoc: true`, so the V2 serializer omits
 *   calendar `date`/`dates` keys entirely for ad-hoc trips.
 * - Scheduling is purely relative: every checkpoint carries `offset_minutes_from_start`
 *   instead of `target_time`, so the drive loop derives alert timing from departure time.
 * - The whole object graph is constructed fresh on every call, which keeps callers free to
 *   mutate the returned trip without leaking state into later invocations.
 *
 * @param today ISO `YYYY-MM-DD` date stored on the day (ignored by the ad-hoc serializer).
 */
export function createSampleTrip(today: string = new Date().toISOString().slice(0, 10)): ParsedTrip {
  return {
    tripName: 'Scenic Southwest: Phoenix to Flagstaff',
    isMultiDay: false,
    isAdHoc: true,
    days: [
      {
        dayNumber: 1,
        date: today,
        title: 'Red Rock Entry & Oak Creek Canyon Switchbacks',
        departureTime: '09:00:00',
        timezone: SAMPLE_TIMEZONE,
        origin: 'Phoenix Sky Harbor International Airport (PHX)',
        destination: 'Flagstaff, AZ',
        isAdHoc: true,
        schedulingMode: 'adhoc',
        waypoints: [
          {
            id: 'phx_rental_pickup',
            name: 'PHX Rental Car Facility',
            type: 'origin',
            lat: 33.4357,
            lng: -112.0152,
            dwell_minutes: 0,
            trigger_radius_miles: 0.5,
            offset_minutes_from_start: 0,
            timezone: SAMPLE_TIMEZONE,
            notification: {
              title: 'Road Trip Begins!',
              message: 'Departing PHX via I-17 N towards Sedona and Oak Creek Canyon.',
              speech:
                'Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona.',
            },
          },
          {
            id: 'sedona_bell_rock',
            name: 'Sedona Red Rock Vistas (Bell Rock Pull-off)',
            type: 'scenic_pull_off',
            lat: 34.801,
            lng: -111.7645,
            dwell_minutes: 15,
            trigger_radius_miles: 3,
            offset_minutes_from_start: 120,
            timezone: SAMPLE_TIMEZONE,
            notification: {
              title: 'Approaching Sedona Red Rocks',
              message:
                'Target arrival: 4:30 PM. Recommended stop for red rock vistas and photos.',
              speech:
                'Approaching Sedona on Highway 179. Pull-offs for Bell Rock and Courthouse Butte coming up in two miles.',
            },
          },
          {
            id: 'oak_creek_switchbacks',
            name: 'Oak Creek Canyon & Vista Viewpoint',
            type: 'scenic_pull_off',
            lat: 35.0345,
            lng: -111.733,
            dwell_minutes: 15,
            trigger_radius_miles: 2,
            offset_minutes_from_start: 165,
            timezone: SAMPLE_TIMEZONE,
            notification: {
              title: 'Oak Creek Canyon Switchbacks',
              message:
                'Target 5:15 PM. Scenic climb on AZ-89A up to Oak Creek Vista overlook.',
              speech:
                'Ascending Oak Creek Canyon switchbacks. Oak Creek Vista viewpoint will be on your right at the top.',
            },
          },
          {
            id: 'flagstaff_arrival',
            name: 'Flagstaff Historic Downtown & Visitor Center',
            type: 'destination',
            lat: 35.1982,
            lng: -111.6465,
            dwell_minutes: 0,
            trigger_radius_miles: 1,
            offset_minutes_from_start: 210,
            timezone: SAMPLE_TIMEZONE,
            notification: {
              title: 'Arrival in Flagstaff',
              message:
                'Arrived in historic Flagstaff. Explore downtown Route 66 and local dining.',
              speech:
                'Arriving in Flagstaff. Welcome to historic Route 66 and the downtown district.',
            },
          },
        ],
      },
    ],
  };
}
