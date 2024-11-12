import { EventEmitter } from "events";
import ConfigLoader from "../helpers/config-loader.js";
import { P2PClient } from "../p2p-сlient.js";
import { multiaddr } from "@multiformats/multiaddr";
import { Connection, PeerId } from "@libp2p/interface";
import { Node } from "../models/node.js";
import { NodeStrategy } from "./node-strategy.js";
import { OutOfLimitError } from "./../models/out-of-limit-error.js";
import { sendDebug } from "./socket-service.js";
import pkg from "debug";
const { debug } = pkg;
export class NetworkService extends EventEmitter {
  private client: P2PClient;
  private nodeStorage: NodeStrategy;
  private localPeer: string | undefined;
  private config = ConfigLoader.getInstance().getConfig();
  private log = (message: string) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    sendDebug("network-service", `[${timestamp}] ${message}`);
    debug("network-service")(`[${timestamp}] ${message}`);
  };
  constructor(p2pClient: P2PClient) {
    super();
    this.client = p2pClient;
    this.nodeStorage = new NodeStrategy(
      this.RequestConnect.bind(this),
      this.RequestDisconnect.bind(this),
      this.RequestRoles.bind(this),
      this.RequestMultiaddrrs.bind(this),
      this.RequestConnectedPeers.bind(this),
      this.RequestPing.bind(this)
    );
    debug.enable("network-service");
  }

  async startAsync(): Promise<void> {
    try {
      await this.client.startNode();
      this.localPeer = this.client.localPeer;
      if (!this.localPeer) {
        this.log("Local peer not found");
        return;
      }

      this.client.on("connection:open", (event: any) => {
        try {
          const conn = event;
          const peerId = event.remotePeer;
          if (!peerId) return;
          if (peerId.toString() === this.localPeer) return;
          if (conn.status !== "open") return;

          this.getNode(peerId.toString(), peerId, conn);
        } catch (error) {
          this.log(
            `Error in connection:open event handler ${JSON.stringify(error)}`
          );
        }
      });

      this.client.on("updateProtocols", (event) => {
        try {
          const { protocols, peerId } = event;
          if (!peerId) return;
          if (peerId.toString() === this.localPeer) return;

          const node = this.getNode(peerId.toString(), peerId, undefined);
          if (protocols && node) {
            protocols.forEach((protocol: string) => {
              if (!node.protocols.has(protocol)) {
                node.protocols.add(protocol);
              }
            });
          }
        } catch (error) {
          this.log(
            `Error in updateProtocols event handler ${JSON.stringify(error)}`
          );
        }
      });
      this.client.on("peer:disconnect", async (event) => {
        try {
          const peerId = event;
          if (!peerId) return;
          this.log(`Connection closed to ${peerId.toString()}`);
          await this.nodeStorage.stopNodeStrategy(
            peerId.toString(),
            `signal from event:peer:disconnect`,
            10000
          );
        } catch (error) {
          this.log(
            `Error in connection:close event handler ${JSON.stringify(error)}`
          );
        }
      });
      await this.nodeStorage
        .startStrategy(this.localPeer.toString())
        .catch((error) => {
          this.log(`Error starting nodeStorage ${JSON.stringify(error)}`);
        });
    } catch (error) {
      this.log(`Error in startAsync ${JSON.stringify(error)}`);
    }
  }

  private getNode(
    peer: string,
    peerId: PeerId | undefined,
    connection: Connection | undefined
  ): Node | undefined {
    try {
      let node = this.nodeStorage.get(peer);
      if (!node) {
        node = new Node(peerId, connection);
        this.nodeStorage.set(peer, node);
      } else {
        if (peerId) {
          node.peerId = peerId;
        }
        if (connection) {
          node.connections.add(connection);
        }
      }
      return node;
    } catch (error) {
      this.log(`Error in getNode ${JSON.stringify(error)}`);
      return undefined;
    }
  }

  private async RequestConnect(addrr: string): Promise<Connection | undefined> {
    try {
      const ma = multiaddr(addrr);
      this.log(`Connecting to ${ma.toString()}`);
      const conn = await this.client.connectTo(ma).catch((error) => {
        this.log(`Error in promise RequestConnect ${JSON.stringify(error)}`);
        return undefined;
      });
      this.log(`Connected to ${ma.toString()}`);
      return conn;
    } catch (error) {
      this.log(`Error in RequestConnect ${JSON.stringify(error)}`);
      return undefined;
    }
  }

  private async RequestDisconnect(addrr: string): Promise<void> {
    try {
      const ma = multiaddr(addrr);
      this.log(`Disconnecting from ${ma.toString()}`);
      await this.client.disconnectFromMA(ma).catch((error) => {
        this.log(`Error in promise RequestDisconnect ${JSON.stringify(error)}`);
      });
    } catch (error) {
      this.log(`Error in RequestDisconnect ${JSON.stringify(error)}`);
    }
  }
  private async RequestRoles(node: Node): Promise<string[] | undefined> {
    if (!node.isConnect() || !node.peerId) return undefined;
    try {
      if (node.protocols.has(this.config.protocols.ROLE)) {
        const connection = node.getOpenedConnection();
        if (!connection) return undefined;

        let rolesStr = await this.client
          .getRolesByAddress(connection)
          .catch((error) => {
            this.log(`Error in promise RequestRoles ${JSON.stringify(error)}`);
            throw error;
          });
        if (!rolesStr || rolesStr.length === 0) return undefined;
        try {
          this.log(`Roles for ${node.peerId?.toString()} is: ${rolesStr}`);
          return JSON.parse(rolesStr);
        } catch (parseError) {
          this.log(`Error parsing roleList JSON ${JSON.stringify(parseError)}`);
          return undefined;
        }
      }
    } catch (error) {
      if (error instanceof OutOfLimitError) {
        this.nodeStorage.stopNodeStrategy(
          node.peerId.toString(),
          "Out of limit",
          10000
        );
      } else {
        this.log(`Error in RequestRoles ${JSON.stringify(error)}`);
      }
      return undefined;
    }
  }
  private async RequestMultiaddrrs(node: Node): Promise<string[] | undefined> {
    if (!node.isConnect() || !node.peerId) return undefined;
    try {
      if (node.protocols.has(this.config.protocols.MULTIADDRES)) {
        const connection = node.getOpenedConnection();
        if (!connection) return undefined;

        let addrrListStr = await this.client
          .getMultiaddresses(connection)
          .catch((error) => {
            this.log(
              `Error in promise RequestMultiaddrrs ${JSON.stringify(error)}`
            );
            throw error;
          });
        if (!addrrListStr || addrrListStr.length === 0) return undefined;
        try {
          this.log(
            `Multiaddrrs for ${node.peerId?.toString()} is: ${addrrListStr}`
          );
          return JSON.parse(addrrListStr);
        } catch (parseError) {
          this.log(
            `Error parsing addrrListStr JSON ${JSON.stringify(parseError)}`
          );
          return undefined;
        }
      }
    } catch (error) {
      if (error instanceof OutOfLimitError) {
        this.nodeStorage.stopNodeStrategy(
          node.peerId.toString(),
          "Out of limit",
          10000
        );
      } else {
        this.log(`Error in RequestMultiaddrrs ${JSON.stringify(error)}`);
      }
      return undefined;
    }
  }
  private async RequestConnectedPeers(node: Node): Promise<any | undefined> {
    if (!node.isConnect() || !node.peerId) return undefined;
    try {
      if (node.protocols.has(this.config.protocols.PEER_LIST)) {
        const connection = node.getOpenedConnection();
        if (!connection) return undefined;

        let peersStr = await this.client
          .getPeerList(connection)
          .catch((error) => {
            this.log(
              `Error in promise RequestConnectedPeers ${JSON.stringify(error)}`
            );
            throw error;
          });
        if (!peersStr || peersStr.length === 0) return undefined;
        try {
          this.log(
            `Connected peers for ${node.peerId?.toString()} is: ${peersStr}`
          );
          return JSON.parse(peersStr);
        } catch (parseError) {
          this.log(`Error parsing peersStr JSON ${JSON.stringify(parseError)}`);
          return undefined;
        }
      }
    } catch (error) {
      if (error instanceof OutOfLimitError) {
        this.nodeStorage.stopNodeStrategy(
          node.peerId.toString(),
          "Out of limit",
          10000
        );
      } else {
        this.log(`Error in RequestConnectedPeers ${JSON.stringify(error)}`);
      }
      return undefined;
    }
  }
  private async RequestPing(addrr: string): Promise<number | undefined> {
    try {
      const lat = await this.client.pingByAddress(addrr).catch((error) => {
        this.log(`Error in promise RequestPing ${JSON.stringify(error)}`);
        throw error;
      });
      this.log(`Ping to ${addrr} is ${lat}ms`);
      return lat;
    } catch (error) {
      if (error instanceof OutOfLimitError) {
        this.log(`Out of limit in connection (${addrr})`);
      } else {
        this.log(`Error in RequestPing ${JSON.stringify(error)}`);
      }
      return undefined;
    }
  }
}