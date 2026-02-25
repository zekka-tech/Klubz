/**
 * Klubz i18n — English + isiZulu string map
 * Usage: t('key') — falls back to English if key missing in active language
 */
(function() {
  'use strict';

  const STRINGS = {
    en: {
      // Navigation
      'nav.home':    'Home',
      'nav.find':    'Find Ride',
      'nav.offer':   'Offer Trip',
      'nav.trips':   'My Trips',
      'nav.profile': 'Profile',

      // Greetings
      'home.greeting.morning':   'Good morning',
      'home.greeting.afternoon': 'Good afternoon',
      'home.greeting.evening':   'Good evening',

      // Buttons
      'btn.book':   'Book Ride',
      'btn.offer':  'Offer Trip',
      'btn.cancel': 'Cancel',
      'btn.save':   'Save',
      'btn.back':   'Back',
      'btn.submit': 'Submit',
      'btn.confirm':'Confirm',
      'btn.verify': 'Verify',

      // Auth
      'auth.login':           'Sign In',
      'auth.register':        'Create Account',
      'auth.logout':          'Log Out',
      'auth.email':           'Email',
      'auth.password':        'Password',
      'auth.forgot':          'Forgot password?',
      'auth.no_account':      "Don't have an account?",
      'auth.have_account':    'Already have an account?',
      'auth.sign_up':         'Sign Up',
      'auth.remember_me':     'Remember me',
      'auth.google':          'Continue with Google',
      'auth.mfa_title':       'Two-Factor Authentication',
      'auth.mfa_subtitle':    'Enter the 6-digit code from your authenticator app',

      // Find Ride
      'find.title':    'Find a Ride',
      'find.subtitle': 'Smart matching finds the best carpool for your route',
      'find.pickup':   'Pickup location',
      'find.dropoff':  'Dropoff location',
      'find.date':     'Date',
      'find.time':     'Time',
      'find.seats':    'Seats needed',
      'find.search':   'Find Matches',
      'find.daily':    'Daily',
      'find.monthly':  'Monthly',

      // Offer Ride
      'offer.title':     'Offer a Ride',
      'offer.subtitle':  'Share your commute, earn money, reduce emissions',
      'offer.departure': 'Departure location',
      'offer.dest':      'Destination',
      'offer.seats':     'Available Seats',
      'offer.price':     'Price (ZAR)',
      'offer.vehicle':   'Vehicle',
      'offer.plate':     'License Plate',
      'offer.notes':     'Notes (optional)',
      'offer.publish':   'Publish Trip',

      // My Trips
      'trips.title':     'My Trips',
      'trips.upcoming':  'Upcoming',
      'trips.completed': 'Completed',
      'trips.cancelled': 'Cancelled',

      // Profile
      'profile.title':    'Profile',
      'profile.settings': 'Settings',
      'profile.carbon':   'Carbon Impact',
      'profile.theme':    'Toggle Theme',
      'profile.logout':   'Log Out',

      // Settings
      'settings.title':       'Settings',
      'settings.mfa':         'Two-Factor Auth',
      'settings.mfa_enable':  'Enable',
      'settings.mfa_disable': 'Disable',
      'settings.language':    'Language',
      'settings.theme':       'Dark Mode',

      // General
      'loading':      'Loading...',
      'error.generic':'Something went wrong. Please try again.',
      'empty.no_trips':'No trips found',
      'status.active':    'Active',
      'status.scheduled': 'Scheduled',
      'status.cancelled': 'Cancelled',
      'status.completed': 'Completed',
    },

    zu: {
      // Navigation
      'nav.home':    'Ikhaya',
      'nav.find':    'Thola Uhambo',
      'nav.offer':   'Nikeza Uhambo',
      'nav.trips':   'Uhambo Lwami',
      'nav.profile': 'Iphrofayili',

      // Greetings
      'home.greeting.morning':   'Sawubona ekuseni',
      'home.greeting.afternoon': 'Sawubona emini',
      'home.greeting.evening':   'Sawubona ntambama',

      // Buttons
      'btn.book':    'Bhuka Uhambo',
      'btn.offer':   'Nikeza Uhambo',
      'btn.cancel':  'Khansela',
      'btn.save':    'Londoloza',
      'btn.back':    'Emuva',
      'btn.submit':  'Thumela',
      'btn.confirm': 'Qinisekisa',
      'btn.verify':  'Qinisekisa',

      // Auth
      'auth.login':           'Ngena',
      'auth.register':        'Dala I-akhawunti',
      'auth.logout':          'Phuma',
      'auth.email':           'I-imeyili',
      'auth.password':        'Iphasiwedi',
      'auth.forgot':          'Ukhohlwe iphasiwedi?',
      'auth.no_account':      'Awunayo i-akhawunti?',
      'auth.have_account':    'Sewunayo i-akhawunti?',
      'auth.sign_up':         'Bhalisa',
      'auth.remember_me':     'Ngikhumbule',
      'auth.google':          'Qhubeka nge-Google',
      'auth.mfa_title':       'Ukuqinisekisa Kabili',
      'auth.mfa_subtitle':    'Faka ikhodi yezinhlamvu eziyisithupha kusuka kusofthiwe yakho yokusayina',

      // Find Ride
      'find.title':    'Thola Uhambo',
      'find.subtitle': 'Ukufanelana okuhlakaniphile kutholela izinto ezilungile',
      'find.pickup':   'Indawo yokuthathwa',
      'find.dropoff':  'Indawo yokushiywa',
      'find.date':     'Usuku',
      'find.time':     'Isikhathi',
      'find.seats':    'Izihlalo ezidingekayo',
      'find.search':   'Thola Ukufanelana',
      'find.daily':    'Nsuku zonke',
      'find.monthly':  'Nyanga zonke',

      // Offer Ride
      'offer.title':     'Nikeza Uhambo',
      'offer.subtitle':  'Yabelana ngohambo lwakho, uzuze imali, wehlise ukukhishwa',
      'offer.departure': 'Indawo yokuphuma',
      'offer.dest':      'Inhloso',
      'offer.seats':     'Izihlalo ezikhona',
      'offer.price':     'Intengo (ZAR)',
      'offer.vehicle':   'Imoto',
      'offer.plate':     'Inombolo yepleti',
      'offer.notes':     'Amanothi (aziyona izidingo)',
      'offer.publish':   'Shicilela Uhambo',

      // My Trips
      'trips.title':     'Uhambo Lwami',
      'trips.upcoming':  'Oluza',
      'trips.completed': 'Oluqedwe',
      'trips.cancelled': 'Olukhansele',

      // Profile
      'profile.title':    'Iphrofayili',
      'profile.settings': 'Izilungiselelo',
      'profile.carbon':   'Umthelela wekhabhoni',
      'profile.theme':    'Guqula isifundo',
      'profile.logout':   'Phuma',

      // Settings
      'settings.title':       'Izilungiselelo',
      'settings.mfa':         'Ukuqinisekisa Kabili',
      'settings.mfa_enable':  'Vula',
      'settings.mfa_disable': 'Vala',
      'settings.language':    'Ulimi',
      'settings.theme':       'Imodi emnyama',

      // General
      'loading':      'Iyalayisha...',
      'error.generic':'Kukhona okungahambanga kahle. Zama futhi.',
      'empty.no_trips':'Awekho uhambo',
      'status.active':    'Kusebenza',
      'status.scheduled': 'Hlelelwe',
      'status.cancelled': 'Khansele',
      'status.completed': 'Kuqediwe',
    },
  };

  window.KLUBZ_STRINGS = STRINGS;

  window.t = function(key) {
    const lang = (typeof Store !== 'undefined' && Store.state && Store.state.user && Store.state.user.preferences && Store.state.user.preferences.language) || 'en';
    return (STRINGS[lang] && STRINGS[lang][key]) || (STRINGS.en && STRINGS.en[key]) || key;
  };
})();
