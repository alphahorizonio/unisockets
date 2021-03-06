import { Mutex } from "async-mutex";
import WebSocket, { Server } from "isomorphic-ws";
import { ClientDoesNotExistError } from "../errors/client-does-not-exist";
import { PortAlreadyAllocatedError } from "../errors/port-already-allocated-error";
import { SubnetDoesNotExistError } from "../errors/subnet-does-not-exist";
import { SuffixDoesNotExistError } from "../errors/suffix-does-not-exist";
import { UnimplementedOperationError } from "../errors/unimplemented-operation";
import { MAlias } from "../models/alias";
import { MMember } from "../models/member";
import { Accept } from "../operations/accept";
import { IAcceptingData } from "../operations/accepting";
import { Acknowledgement } from "../operations/acknowledgement";
import { Alias } from "../operations/alias";
import { Answer, IAnswerData } from "../operations/answer";
import { IBindData } from "../operations/bind";
import { Candidate, ICandidateData } from "../operations/candidate";
import { IConnectData } from "../operations/connect";
import { Goodbye } from "../operations/goodbye";
import { Greeting } from "../operations/greeting";
import { IKnockData } from "../operations/knock";
import { IOfferData, Offer } from "../operations/offer";
import {
  ESIGNALING_OPCODES,
  ISignalingOperation,
  TSignalingData,
} from "../operations/operation";
import { IShutdownData } from "../operations/shutdown";
import { SignalingService } from "./signaling-service";

export class SignalingServer extends SignalingService {
  private clients = new Map<string, WebSocket>();
  private aliases = new Map<string, MAlias>();
  protected server?: Server;

  constructor(private host: string, private port: number) {
    super();
  }

  async open() {
    this.logger.debug("Opening signaling server");

    const server = new Server({
      host: this.host,
      port: this.port,
    });

    await new Promise<void>(
      (res) => server.once("listening", () => res()) // We create it above, so this can't be undefined
    );

    server.on("connection", async (client) => {
      (client as any).isAlive = true;

      client.on("pong", function () {
        (this as any).isAlive = true;
      });

      client.on(
        "message",
        async (operation) =>
          await this.handleOperation(await this.receive(operation), client)
      );
    });

    const interval = setInterval(
      () =>
        server.clients.forEach((client) => {
          if ((client as any).isAlive === false) {
            this.logger.verbose("Client disconnected");

            return client.terminate();
          }

          (client as any).isAlive = false;

          this.logger.debug("Pinging client");

          client.ping(() => {});
        }),
      30000
    );

    server.on("close", function close() {
      clearInterval(interval);
    });

    this.logger.verbose("Listening", {
      host: this.host,
      port: this.port,
    });

    this.server = server;
  }

  async close() {
    this.logger.debug("Shutting down signaling server");

    await new Promise<void>((res, rej) =>
      this.server ? this.server.close((e) => (e ? rej(e) : res())) : res()
    );

    this.logger.debug("Closed signaling server");
  }

  private async registerGoodbye(id: string) {
    this.logger.silly("Registering goodbye", { id });

    if (this.clients.has(id)) {
      const client = this.clients.get(id)!; // `.has` checks this

      client.on("close", async () => {
        this.clients.delete(id);
        await this.removeIPAddress(id);

        this.aliases.forEach(async ({ id: clientId }, alias) => {
          if (clientId === id) {
            this.aliases.delete(alias);
            await this.removeIPAddress(alias);
            await this.removeTCPAddress(alias);

            this.clients.forEach(async (client) => {
              await this.send(client, new Alias({ id, alias, set: false }));

              this.logger.debug("Sent alias", { id, alias });
            });
          }
        });

        this.clients.forEach(
          async (client) => await this.send(client, new Goodbye({ id }))
        );

        this.logger.verbose("Client disconnected", { id });
      });
    } else {
      throw new ClientDoesNotExistError();
    }
  }

  private async handleOperation(
    operation: ISignalingOperation<TSignalingData>,
    client: WebSocket
  ) {
    this.logger.silly("Handling operation", { operation, client });

    switch (operation.opcode) {
      case ESIGNALING_OPCODES.KNOCK: {
        const data = operation.data as IKnockData;

        this.logger.debug("Received knock", data);

        await this.handleKnock(data, client);

        break;
      }

      case ESIGNALING_OPCODES.OFFER: {
        const data = operation.data as IOfferData;

        this.logger.debug("Received offer", data);

        await this.handleOffer(data);

        break;
      }

      case ESIGNALING_OPCODES.ANSWER: {
        const data = operation.data as IAnswerData;

        this.logger.debug("Received answer", data);

        await this.handleAnswer(data);

        break;
      }

      case ESIGNALING_OPCODES.CANDIDATE: {
        const data = operation.data as ICandidateData;

        this.logger.debug("Received candidate", data);

        await this.handleCandidate(data);

        break;
      }

      case ESIGNALING_OPCODES.BIND: {
        const data = operation.data as IBindData;

        this.logger.debug("Received bind", data);

        await this.handleBind(data);

        break;
      }

      case ESIGNALING_OPCODES.ACCEPTING: {
        const data = operation.data as IAcceptingData;

        this.logger.debug("Received accepting", data);

        await this.handleAccepting(data);

        break;
      }

      case ESIGNALING_OPCODES.SHUTDOWN: {
        const data = operation.data as IShutdownData;

        this.logger.debug("Received shutdown", data);

        await this.handleShutdown(data);

        break;
      }

      case ESIGNALING_OPCODES.CONNECT: {
        const data = operation.data as IConnectData;

        this.logger.debug("Received connect", data);

        await this.handleConnect(data);

        break;
      }

      default: {
        throw new UnimplementedOperationError(operation.opcode);
      }
    }
  }

  private async handleKnock(data: IKnockData, client: WebSocket) {
    this.logger.silly("Handling knock", { data, client });

    const id = await this.createIPAddress(data.subnet);

    if (id !== "-1") {
      await this.send(client, new Acknowledgement({ id, rejected: false }));
    } else {
      await this.send(client, new Acknowledgement({ id, rejected: true }));

      this.logger.debug("Knock rejected", {
        id,
        reason: "subnet overflow",
      });

      return;
    }

    this.clients.forEach(async (existingClient, existingId) => {
      if (existingId !== id) {
        await this.send(
          existingClient,
          new Greeting({
            offererId: existingId,
            answererId: id,
          })
        );

        this.logger.debug("Sent greeting", {
          offererId: existingId,
          answererId: id,
        });
      }
    });

    this.clients.set(id, client);
    await this.registerGoodbye(id);

    this.logger.verbose("Client connected", { id });
  }

  private async handleOffer(data: IOfferData) {
    this.logger.silly("Handling offer", { data });

    const client = this.clients.get(data.answererId);

    await this.send(
      client,
      new Offer({
        offererId: data.offererId,
        answererId: data.answererId,
        offer: data.offer,
      })
    );

    this.logger.debug("Sent offer", {
      offererId: data.offererId,
      answererId: data.answererId,
      offer: data.offer,
    });
  }

  private async handleAnswer(data: IAnswerData) {
    this.logger.silly("Handling answer", { data });

    const client = this.clients.get(data.offererId);

    await this.send(client, new Answer(data));

    this.logger.debug("Sent answer", data);
  }

  private async handleCandidate(data: ICandidateData) {
    this.logger.silly("Handling candidate", { data });

    const client = this.clients.get(data.answererId);

    await this.send(client, new Candidate(data));

    this.logger.debug("Sent candidate", data);
  }

  private async handleBind(data: IBindData) {
    this.logger.silly("Handling bind", { data });

    if (this.aliases.has(data.alias)) {
      this.logger.debug("Rejecting bind, alias already taken", data);

      const client = this.clients.get(data.id);

      await this.send(
        client,
        new Alias({ id: data.id, alias: data.alias, set: false })
      );
    } else {
      this.logger.debug("Accepting bind", data);

      await this.claimTCPAddress(data.alias);

      this.aliases.set(data.alias, new MAlias(data.id, false));

      this.clients.forEach(async (client, id) => {
        await this.send(
          client,
          new Alias({ id: data.id, alias: data.alias, set: true })
        );

        this.logger.debug("Sent alias", { id, data });
      });
    }
  }

  private async handleAccepting(data: IAcceptingData) {
    this.logger.silly("Handling accepting", { data });

    if (
      !this.aliases.has(data.alias) ||
      this.aliases.get(data.alias)!.id !== data.id // `.has` checks this
    ) {
      this.logger.debug("Rejecting accepting, alias does not exist", data);
    } else {
      this.logger.debug("Accepting accepting", data);

      this.aliases.set(data.alias, new MAlias(data.id, true));
    }
  }

  private async handleShutdown(data: IShutdownData) {
    this.logger.silly("Handling shutdown", { data });

    if (
      this.aliases.has(data.alias) &&
      this.aliases.get(data.alias)!.id === data.id // `.has` checks this
    ) {
      this.aliases.delete(data.alias);
      await this.removeTCPAddress(data.alias);
      await this.removeIPAddress(data.alias);

      this.logger.debug("Accepting shutdown", data);

      this.clients.forEach(async (client, id) => {
        await this.send(
          client,
          new Alias({ id: data.id, alias: data.alias, set: false })
        );

        this.logger.debug("Sent alias", { id, data });
      });
    } else {
      this.logger.debug(
        "Rejecting shutdown, alias not taken or incorrect client ID",
        data
      );

      const client = this.clients.get(data.id);

      await this.send(
        client,
        new Alias({ id: data.id, alias: data.alias, set: true })
      );
    }
  }

  private async handleConnect(data: IConnectData) {
    this.logger.silly("Handling connect", { data });

    const clientAlias = await this.createTCPAddress(data.id);
    const client = this.clients.get(data.id);

    if (
      !this.aliases.has(data.remoteAlias) ||
      !this.aliases.get(data.remoteAlias)!.accepting // `.has` checks this
    ) {
      this.logger.debug("Rejecting connect, remote alias does not exist", {
        data,
      });

      await this.removeTCPAddress(clientAlias);

      await this.send(
        client,
        new Alias({
          id: data.id,
          alias: clientAlias,
          set: false,
          clientConnectionId: data.clientConnectionId,
        })
      );
    } else {
      this.logger.debug("Accepting connect", {
        data,
      });

      this.aliases.set(clientAlias, new MAlias(data.id, false));

      const clientAliasMessage = new Alias({
        id: data.id,
        alias: clientAlias,
        set: true,
        clientConnectionId: data.clientConnectionId,
        isConnectionAlias: true,
      });

      await this.send(client, clientAliasMessage);

      this.logger.debug("Sent alias for connection to client", {
        data,
        alias: clientAliasMessage,
      });

      const serverId = this.aliases.get(data.remoteAlias)!; // `.has` checks this
      const server = this.clients.get(serverId.id);

      const serverAliasMessage = new Alias({
        id: data.id,
        alias: clientAlias,
        set: true,
      });

      await this.send(server, serverAliasMessage);

      this.logger.debug("Sent alias for connection to server", {
        data,
        alias: serverAliasMessage,
      });

      const serverAcceptMessage = new Accept({
        boundAlias: data.remoteAlias,
        clientAlias: clientAlias,
      });

      await this.send(server, serverAcceptMessage);

      this.logger.debug("Sent accept to server", {
        data,
        accept: serverAcceptMessage,
      });

      const serverAliasForClientsMessage = new Alias({
        id: serverId.id,
        alias: data.remoteAlias,
        set: true,
        clientConnectionId: data.clientConnectionId,
      });

      await this.send(client, serverAliasForClientsMessage);

      this.logger.debug("Sent alias for server to client", {
        data,
        alias: serverAliasForClientsMessage,
      });
    }
  }

  private subnets = new Map<string, Map<number, MMember>>();
  private subnetsMutex = new Mutex();

  private async createIPAddress(subnet: string) {
    this.logger.silly("Creating IP address", { subnet });

    const release = await this.subnetsMutex.acquire();

    try {
      if (!this.subnets.has(subnet)) {
        this.subnets.set(subnet, new Map());
      }

      const existingMembers = Array.from(this.subnets.get(subnet)!.keys()).sort(
        (a, b) => a - b
      ); // We ensure above

      // Find the next free suffix
      const newSuffix: number = await new Promise((res) => {
        existingMembers.forEach((suffix, index) => {
          suffix !== index && res(index);
        });

        res(existingMembers.length);
      });

      if (newSuffix > 255) {
        return "-1";
      }

      const newMember = new MMember([]);

      this.subnets.get(subnet)!.set(newSuffix, newMember); // We ensure above

      return this.toIPAddress(subnet, newSuffix);
    } finally {
      release();
    }
  }

  private async createTCPAddress(ipAddress: string) {
    this.logger.silly("Creating TCP address", { ipAddress });

    const release = await this.subnetsMutex.acquire();

    try {
      const { subnet, suffix } = this.parseIPAddress(ipAddress);

      if (this.subnets.has(subnet)) {
        if (this.subnets.get(subnet)!.has(suffix)) {
          const existingPorts = this.subnets
            .get(subnet)!
            .get(suffix)!
            .ports.sort((a, b) => a - b); // We ensure above

          // Find next free port
          const newPort: number = await new Promise((res) => {
            existingPorts.forEach((port, index) => {
              port !== index && res(index);
            });

            res(existingPorts.length);
          });

          this.subnets.get(subnet)!.get(suffix)!.ports.push(newPort); // We ensure above

          return this.toTCPAddress(this.toIPAddress(subnet, suffix), newPort);
        } else {
          throw new SuffixDoesNotExistError();
        }
      } else {
        throw new SubnetDoesNotExistError();
      }
    } finally {
      release();
    }
  }

  private async claimTCPAddress(tcpAddress: string) {
    this.logger.silly("Claiming TCP address", { tcpAddress });

    const release = await this.subnetsMutex.acquire();

    try {
      const { ipAddress, port } = this.parseTCPAddress(tcpAddress);
      const { subnet, suffix } = this.parseIPAddress(ipAddress);

      if (this.subnets.has(subnet)) {
        if (!this.subnets.get(subnet)!.has(suffix)) {
          this.subnets.get(subnet)!.set(suffix, new MMember([])); // We ensure above
        }

        if (
          this.subnets
            .get(subnet)!
            .get(suffix)!
            .ports.find((p) => p === port) === undefined
        ) {
          this.subnets.get(subnet)!.get(suffix)!.ports.push(port); // We ensure above
        } else {
          throw new PortAlreadyAllocatedError();
        }
      } else {
        throw new SubnetDoesNotExistError();
      }
    } finally {
      release();
    }
  }

  private async removeIPAddress(ipAddress: string) {
    this.logger.silly("Removing IP address", { ipAddress });

    const release = await this.subnetsMutex.acquire();

    try {
      const { subnet, suffix } = this.parseIPAddress(ipAddress);

      if (this.subnets.has(subnet)) {
        if (this.subnets.get(subnet)!.has(suffix)) {
          this.subnets.get(subnet)!.delete(suffix); // We ensure above
        }
      }
    } finally {
      release();
    }
  }

  private async removeTCPAddress(tcpAddress: string) {
    this.logger.silly("Removing TCP address", { tcpAddress });

    const release = await this.subnetsMutex.acquire();

    try {
      const { ipAddress, port } = this.parseTCPAddress(tcpAddress);
      const { subnet, suffix } = this.parseIPAddress(ipAddress);

      if (this.subnets.has(subnet)) {
        if (this.subnets.get(subnet)!.has(suffix)) {
          this.subnets.get(subnet)!.get(suffix)!.ports = this.subnets
            .get(subnet)!
            .get(suffix)!
            .ports.filter((p) => p !== port); // We ensure above
        }
      }
    } finally {
      release();
    }
  }

  private toIPAddress(subnet: string, suffix: number) {
    this.logger.silly("Converting to IP address", { subnet, suffix });

    return `${subnet}.${suffix}`;
  }

  private toTCPAddress(ipAddress: string, port: number) {
    this.logger.silly("Converting to TCP address", { ipAddress, port });

    return `${ipAddress}:${port}`;
  }

  private parseIPAddress(ipAddress: string) {
    this.logger.silly("Parsing IP address", { ipAddress });

    const parts = ipAddress.split(".");

    return {
      subnet: parts.slice(0, 3).join("."),
      suffix: parseInt(parts[3]),
    };
  }

  private parseTCPAddress(tcpAddress: string) {
    this.logger.silly("Parsing TCP address", { tcpAddress });

    const parts = tcpAddress.split(":");

    return {
      ipAddress: parts[0],
      port: parseInt(parts[1]),
    };
  }
}
