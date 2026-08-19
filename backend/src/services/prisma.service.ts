import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private connected = false;

  async onModuleInit() {
    try {
      await this.$connect();
      this.connected = true;
    } catch (error) {
      this.connected = false;
      console.warn('Prisma connection failed, API will use fallback responses until DB becomes available.');
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  isConnected() {
    return this.connected;
  }

  async ensureConnection() {
    if (this.connected) {
      return true;
    }

    try {
      await this.$connect();
      this.connected = true;
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }
}
