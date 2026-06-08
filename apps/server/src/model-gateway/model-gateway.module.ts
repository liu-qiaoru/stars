import { Module } from '@nestjs/common'
import { ConfigModule } from '../config/config.module.js'
import { ModelGatewayService } from './model-gateway.service.js'

@Module({
  imports: [ConfigModule],
  providers: [ModelGatewayService],
  exports: [ModelGatewayService],
})
export class ModelGatewayModule {}
