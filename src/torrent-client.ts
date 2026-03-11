/**
 * Common interface all torrent-client adapters must implement.
 * Allows the state machine to treat Transmission and qBittorrent uniformly.
 */
export interface TorrentClient {
  /** Display name used in log messages, e.g. "Transmission" or "qBittorrent". */
  readonly clientName: string;

  /** Docker container name for this client. */
  readonly containerName: string;

  /** Returns true if the client's HTTP API is up and responding. */
  checkHealth(): Promise<boolean>;

  /** Returns all torrent identifiers (numeric IDs for Transmission, hash strings for qBittorrent). */
  getAllTorrentIds(): Promise<(number | string)[]>;

  /** Pauses/stops the given torrents. */
  stopAllTorrents(ids: (number | string)[]): Promise<void>;

  /** Resumes/starts the given torrents. */
  startAllTorrents(ids: (number | string)[]): Promise<void>;

  /** Re-announces all torrents to their trackers. */
  reannounceAllTorrents(): Promise<void>;

  /**
   * Checks tracker connectivity for active torrents.
   *   true  = at least one tracker is announcing successfully.
   *   false = all trackers with announce history are failing.
   *   null  = no active torrents or no announce history yet (insufficient data).
   */
  checkTrackerConnectivity(): Promise<boolean | null>;

  /**
   * Returns the current peer-listen port configured in the client.
   * Returns null if the client does not support peer-port management.
   */
  getSessionPeerPort(): Promise<number | null>;

  /**
   * Updates the peer-listen port in the client's settings.
   * Should be a no-op (not throw) if the client does not support port management.
   */
  setSessionPeerPort(port: number): Promise<void>;

  /**
   * Performs an internal health check by exec-ing a probe command inside the
   * VPN container's network namespace.  Used to distinguish "client temporarily
   * busy" from "client process crashed" when the external API is unresponsive.
   * Returns true = client responded; false = client appears dead.
   */
  checkInternalHealth(): Promise<boolean>;
}
