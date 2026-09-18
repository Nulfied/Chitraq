/**
 * The small amount of world knowledge Chitraq is willing to hold.
 *
 * Recognising places is the one entity problem that cannot be solved from shape
 * alone. "Reading" and "Mobile" and "Turkey" are places; so are "Springfield"
 * and "Kochi", which look like nothing in particular. A model would know. A
 * regex cannot.
 *
 * So this is a list, kept deliberately short and deliberately boring: countries
 * and the cities large enough that a note mentioning one probably means the
 * city. Everything outside it is found by shape — "Oxford Street", "Heathrow
 * Airport", "based in Pune" — or not found at all, which is the correct outcome
 * for a place Chitraq has no way to recognise.
 *
 * It is not a geography database and should never grow into one. When a vision
 * of "complete coverage" appears, the answer is a model, not a longer list.
 */

/** Countries and widely-used short forms. */
export const COUNTRIES = new Set(
  [
    'Afghanistan', 'Albania', 'Algeria', 'Argentina', 'Armenia', 'Australia', 'Austria',
    'Azerbaijan', 'Bahrain', 'Bangladesh', 'Belarus', 'Belgium', 'Bhutan', 'Bolivia',
    'Bosnia', 'Botswana', 'Brazil', 'Bulgaria', 'Cambodia', 'Cameroon', 'Canada', 'Chile',
    'China', 'Colombia', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Ecuador',
    'Egypt', 'Estonia', 'Ethiopia', 'Finland', 'France', 'Georgia', 'Germany', 'Ghana',
    'Greece', 'Guatemala', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq',
    'Ireland', 'Israel', 'Italy', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya',
    'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Libya', 'Lithuania', 'Luxembourg',
    'Madagascar', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Mexico', 'Moldova', 'Mongolia',
    'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal', 'Netherlands',
    'Nicaragua', 'Nigeria', 'Norway', 'Oman', 'Pakistan', 'Panama', 'Paraguay', 'Peru',
    'Philippines', 'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda',
    'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'Somalia',
    'Spain', 'Sudan', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania',
    'Thailand', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'Uruguay', 'Uzbekistan',
    'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
    'South Korea', 'North Korea', 'South Africa', 'New Zealand', 'Sri Lanka',
    'United States', 'United Kingdom', 'United Arab Emirates', 'Costa Rica',
    'Dominican Republic', 'Papua New Guinea', 'Ivory Coast', 'Hong Kong',
    'USA', 'UK', 'UAE', 'US', 'Britain', 'England', 'Scotland', 'Wales',
  ].map((s) => s.toLowerCase())
);

/**
 * Cities big enough that the name usually means the city.
 *
 * Chosen for size and for how often they show up in working notes, not for
 * completeness. A city not on this list is still found when the sentence gives
 * a cue — "our office in Coimbatore" — which is the more reliable signal anyway.
 */
export const CITIES = new Set(
  [
    'Tokyo', 'Delhi', 'Shanghai', 'Dhaka', 'Cairo', 'Mumbai', 'Beijing', 'Osaka',
    'Karachi', 'Chongqing', 'Istanbul', 'Buenos Aires', 'Kolkata', 'Lagos', 'Manila',
    'Guangzhou', 'Bangalore', 'Bengaluru', 'Shenzhen', 'Moscow', 'Jakarta', 'Lahore',
    'Seoul', 'Bangkok', 'Chennai', 'Hyderabad', 'London', 'Tehran', 'Paris', 'Chicago',
    'Toronto', 'Bogota', 'Lima', 'Johannesburg', 'Hanoi', 'Riyadh', 'Santiago',
    'Madrid', 'Singapore', 'Sydney', 'Melbourne', 'Berlin', 'Rome', 'Amsterdam',
    'Barcelona', 'Vienna', 'Dublin', 'Lisbon', 'Copenhagen', 'Stockholm', 'Oslo',
    'Helsinki', 'Warsaw', 'Prague', 'Budapest', 'Athens', 'Zurich', 'Geneva', 'Munich',
    'Hamburg', 'Frankfurt', 'Milan', 'Brussels', 'Dubai', 'Doha', 'Tel Aviv',
    'New York', 'Los Angeles', 'San Francisco', 'Seattle', 'Boston', 'Austin',
    'Denver', 'Atlanta', 'Miami', 'Houston', 'Dallas', 'Philadelphia', 'Phoenix',
    'Washington', 'Vancouver', 'Montreal', 'Ottawa', 'Calgary', 'Auckland',
    'Wellington', 'Perth', 'Brisbane', 'Pune', 'Ahmedabad', 'Jaipur', 'Kochi',
    'Surat', 'Lucknow', 'Nagpur', 'Indore', 'Chandigarh', 'Noida', 'Gurgaon',
    'Gurugram', 'Kathmandu', 'Colombo', 'Taipei', 'Kyoto', 'Busan',
  ].map((s) => s.toLowerCase())
);

/**
 * Suffixes that make a capitalised phrase a place whatever the words are.
 * "Oxford Street" needs no gazetteer; the last word does the work.
 */
export const PLACE_SUFFIX =
  /\b(street|road|avenue|lane|boulevard|highway|bridge|airport|station|harbour|harbor|port|park|square|plaza|valley|island|beach|bay|river|lake|mountain|county|province|district|city|town|village|campus)\b$/i;

/**
 * Is this the name of a place Chitraq is prepared to recognise?
 * @param {string} value
 */
export function isKnownPlace(value) {
  const key = value.trim().toLowerCase().replace(/^the\s+/, '');
  return COUNTRIES.has(key) || CITIES.has(key) || PLACE_SUFFIX.test(value.trim());
}
