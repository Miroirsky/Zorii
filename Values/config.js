window.ZORII_CONFIG = {
  APP_PREFIX: 'zorii-p2p-v1-',
  DISCOVERY_TOPIC: 'zorii/v1/rooms/lobby',
  BROADCAST_CHANNEL: 'zorii_local_bus_v1',
  STORAGE_USER_KEY: 'zorii_username',
  STORAGE_ROOMS_KEY: 'zorii_cached_rooms_v1',
  MQTT_BROKERS: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ],
  HEARTBEAT_MS: 4000,
  ROOM_TTL_MS: 14000,
  MIN_MEMBERS: 5,
  MAX_MEMBERS: 100
};
