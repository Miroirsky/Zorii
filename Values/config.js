window.ZORII_CONFIG = {
  APP_PREFIX: 'zorii-host-v2-',
  REGISTRY_PREFIX: 'zorii/v2/registry/',
  ROOM_TOPIC_PREFIX: 'zorii/v2/room/',
  BROADCAST_CHANNEL: 'zorii_bus_v2',
  STORAGE_USER_KEY: 'zorii_username',
  STORAGE_ROOMS_KEY: 'zorii_rooms_v2',
  STORAGE_ROOM_STATE_PREFIX: 'zorii_state_v2_',
  MQTT_BROKERS: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ],
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ],
  HEARTBEAT_MS: 3000,
  ROOM_TTL_MS: 12000,
  MIN_MEMBERS: 5,
  MAX_MEMBERS: 100
};
