import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Сырое тело нужно для проверки HMAC-подписи вебхуков 1С:
    // пересборка JSON.stringify не гарантирует тот же байтовый вид
    rawBody: true,
  });

  app.enableCors();
  app.setGlobalPrefix('api/v1');

  const config = new DocumentBuilder()
    .setTitle('ЦМК АВРОРА — ERP REST API')
    .setDescription('REST API v1 ЦМК АВРОРА — планирование производства, заказы, склад, финансы')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  // Save OpenAPI JSON spec file for alignment check
  const swaggerJsonPath = path.join(__dirname, '..', 'openapi-spec.json');
  fs.writeFileSync(swaggerJsonPath, JSON.stringify(document, null, 2), 'utf8');

  // BACKEND_PORT, а не PORT: PORT перехватывают dev-обёртки (preview, PaaS)
  // и backend случайно занимает порт vite (5173)
  const port = process.env.BACKEND_PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}/api/v1`);
  console.log(`Swagger documentation is available at: http://localhost:${port}/api/v1/docs`);
}

if (require.main === module) {
  bootstrap();
}
