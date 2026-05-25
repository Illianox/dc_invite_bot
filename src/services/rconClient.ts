import { Socket } from "node:net";
import type { RconServerConfig } from "../config/referralRewards.js";

export interface RewardCommandResult {
  serverName: string;
  command: string;
  status: "dry_run" | "success";
}

export class RconRewardClient {
  public async execute(server: RconServerConfig, command: string, dryRun: boolean): Promise<RewardCommandResult> {
    if (dryRun) return { serverName: server.name, command, status: "dry_run" };
    const connection = new SourceRconConnection(server);
    await connection.connect();
    try {
      await connection.authenticate();
      await connection.command(command);
      return { serverName: server.name, command, status: "success" };
    } finally {
      connection.close();
    }
  }
}

class SourceRconConnection {
  private socket: Socket | null = null;
  private requestId = 1;
  private readonly pending = new Map<number, (packet: RconPacket) => void>();

  public constructor(private readonly server: RconServerConfig) {}

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.setTimeout(10_000);
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error(`RCON timeout on ${this.server.name}`)));
      socket.on("data", (data) => this.receive(data));
      socket.connect(this.server.port, this.server.host);
    });
  }

  public async authenticate(): Promise<void> {
    const response = await this.send(3, this.server.password);
    if (response.id === -1) throw new Error(`RCON authentication failed on ${this.server.name}`);
  }

  public async command(command: string): Promise<string> {
    const response = await this.send(2, command);
    return response.body;
  }

  public close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private send(type: number, body: string): Promise<RconPacket> {
    if (!this.socket) throw new Error("RCON socket is not connected.");
    const id = this.requestId++;
    const packet = encodePacket(id, type, body);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RCON command timeout on ${this.server.name}`));
      }, 10_000);
      this.pending.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      this.socket!.write(packet);
    });
  }

  private receive(data: Buffer): void {
    let offset = 0;
    while (offset + 4 <= data.length) {
      const size = data.readInt32LE(offset);
      if (offset + 4 + size > data.length) return;
      const id = data.readInt32LE(offset + 4);
      const type = data.readInt32LE(offset + 8);
      const body = data.subarray(offset + 12, offset + 4 + size - 2).toString("utf8");
      const packet = { id, type, body };
      const handler = this.pending.get(id) ?? (id === -1 ? Array.from(this.pending.values())[0] : undefined);
      if (handler) {
        this.pending.delete(id);
        handler(packet);
      }
      offset += 4 + size;
    }
  }
}

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBytes = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBytes.length + 2;
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBytes.copy(packet, 12);
  packet.writeInt16LE(0, 12 + bodyBytes.length);
  return packet;
}
