/* Config Sample
 *
 * For more information on how you can configure this file
 * see https://docs.magicmirror.builders/configuration/introduction.html
 * and https://docs.magicmirror.builders/modules/configuration.html
 *
 * You can use environment variables using a `config.js.template` file instead of `config.js`
 * which will be converted to `config.js` while starting. For more information
 * see https://docs.magicmirror.builders/configuration/introduction.html#enviromnent-variables
 */
let config = {
	address: "localhost",	// Address to listen on, can be:
							// - "localhost", "127.0.0.1", "::1" to listen on loopback interface
							// - another specific IPv4/6 to listen on a specific interface
							// - "0.0.0.0", "::" to listen on any interface
							// Default, when address config is left out or empty, is "localhost"
	port: 8080,
	basePath: "/",	// The URL path where MagicMirror² is hosted. If you are using a Reverse proxy
									// you must set the sub path here. basePath must end with a /
	ipWhitelist: ["127.0.0.1", "::ffff:127.0.0.1", "::1"],	// Set [] to allow all IP addresses
									// or add a specific IPv4 of 192.168.1.5 :
									// ["127.0.0.1", "::ffff:127.0.0.1", "::1", "::ffff:192.168.1.5"],
									// or IPv4 range of 192.168.3.0 --> 192.168.3.15 use CIDR format :
									// ["127.0.0.1", "::ffff:127.0.0.1", "::1", "::ffff:192.168.3.0/28"],

	useHttps: false,			// Support HTTPS or not, default "false" will use HTTP
	httpsPrivateKey: "",	// HTTPS private key path, only require when useHttps is true
	httpsCertificate: "",	// HTTPS Certificate path, only require when useHttps is true

	language: "en",
	locale: "en-US",   // this variable is provided as a consistent location
			   // it is currently only used by 3rd party modules. no MagicMirror code uses this value
			   // as we have no usage, we  have no constraints on what this field holds
			   // see https://en.wikipedia.org/wiki/Locale_(computer_software) for the possibilities

	logLevel: ["INFO", "LOG", "WARN", "ERROR"], // Add "DEBUG" for even more logging
	timeFormat: 24,
	units: "metric",

	modules: [
		{
			module: "MMM-PlexusBackground",
			position: "fullscreen_below",
		},
		{
			module: "alert",
		},
		{
			module: "updatenotification",
			position: "top_bar"
		},
		{
			module: "clock",
			position: "top_left"
		},















		{
			module: "MMM-Traffic",
			position: "top_left",
			header: "Commute",
			config: {
				origin: "Zlavovruh 32, Sofia",
				destination: "CommerzBank DTC Sofia Mladost",
				apiKey: "${SECRET_GOOGLE_MAPS_API_KEY}",
				mode: "driving",
				rushStart: "07:50",
				rushEnd: "09:30",
				rushInterval: 5 * 60000,
				idleInterval: 120 * 60000,
				label: "Work"
			}
		},
		{
			module: "MMM-Luigi",
			position: "lower_third",
			config: {
				wakeDelayMs: 7000,
				goodbyeDelayMs: 8000,
				greetingCooldownMs: 60000,
				typingSpeedMs: 50,
				cardCycleMs: 10000,
				cards: ["weather", "commute", "football", "news"],
				dayFlavor: true,
				weatherLat: 42.6977,
				weatherLon: 23.3219,
				news: {
					enabled: true,
					// Retired models 404. List what the key can reach with:
					// curl "https://generativelanguage.googleapis.com/v1beta/models?key=$KEY"
					model: "gemini-3.6-flash",
					/*
					 * 4 topics x 1440 / 64 = 90 min, the shortest interval that fits a
					 * 64-call-a-day Gemini budget. Adding a topic means recomputing
					 * this, or the budget moves without anyone deciding to move it.
					 */
					refreshIntervalMs: 90 * 60 * 1000,
					maxHeadlinesPerTopic: 5,
					newsLineCycleMs: 6000,
					// `sources` must match the newsfeed feed titles exactly.
					topics: [
						{ id: "tech", label: "Tech", sources: ["TechCrunch", "The Verge"] },
						{ id: "space", label: "Space", sources: ["NASA"] },
						{ id: "bulgaria", label: "Bulgaria", sources: ["Novinite"] },
						{ id: "ai", label: "AI", sources: ["OpenAI"] }
					]
				}
			}
		},
		{
		        module: "weather",
		        position: "top_right",
		        config: {
		                weatherProvider: "openmeteo",
		                type: "current_hourly",
		                maxEntries: 6,
		                lat: 42.6977,
		                lon: 23.3219,
		                roundTemp: true,
		                updateInterval: 60 * 60 * 1000
		        }
		},		{
			module: "weather",
			position: "top_right",
			header: "Weather Forecast Sofia",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: 42.6977,
				lon: 23.3219,
				roundTemp: true,
				updateInterval: 60 * 60 * 1000
			}
		},
		{
			module: "MMM-InsideWeather",
			position: "top_right",
			config: {
				updateInterval: 60000,
				i2cBusNo: 1,
				i2cAddress: 0x77
			}
		},
		{
		        module: "weather",
		        position: "top_right",
		        config: {
		                weatherProvider: "openmeteo",
		                type: "current_hourly",
		                maxEntries: 6,
		                lat: 43.2141,
		                lon: 27.9147,
		                roundTemp: true,
		                updateInterval: 60 * 60 * 1000
		        }
		},		{
			module: "MMM-SpotifyPlaying",
			position: "bottom_left",
			config: {
				clientId: "00563b8e207d424ca52b1b6021270751",
				clientSecret: "${SECRET_SPOTIFY_CLIENT_SECRET}",
				refreshToken: "${SECRET_SPOTIFY_REFRESH_TOKEN}",
				updateInterval: 4000,
				showProgressBar: true,
				albumArtSize: 80,
				albumArtPosition: "left",
				grayscale: false,
				hideWhenPaused: false
			}
		},
		{
			module: "MMM-Football",
			position: "top_left",
			header: "Football",
			config: {
				apiKey: "${SECRET_FOOTBALL_API_KEY}",
				leagues: [2021, 2014, 2015, 2001],
				teams: [61, 64, 65, 66, 78, 81, 86, 524],
				timeZone: "Europe/Sofia",
			}
		},
		/*
		 * No position on purpose: this stops rendering the bottom bar but keeps the
		 * module fetching and broadcasting, so it is Luigi's RSS source rather than
		 * a second poller. js/loader.js loads modules with an undefined position.
		 *
		 * Feed titles are publication names, and they must match the `sources`
		 * lists in MMM-Luigi's news config exactly — that string equality is the
		 * join between the two blocks.
		 */
		{
			module: "newsfeed",
			config: {
				feeds: [
					{ title: "TechCrunch", url: "https://techcrunch.com/feed/" },
					{ title: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
					{ title: "NASA", url: "https://www.nasa.gov/feed/" },
					// /rss/ redirects to a 404; this is the live endpoint.
					{ title: "Novinite", url: "https://www.novinite.com/services/rss.php" },
					{ title: "OpenAI", url: "https://openai.com/blog/rss.xml" }
				],
				broadcastNewsFeeds: true,
				broadcastNewsUpdates: true
			}
		},
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
