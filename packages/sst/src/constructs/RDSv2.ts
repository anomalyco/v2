import path from 'path';
import { globSync } from 'glob';
import fs from 'fs';
import url from 'url';
import * as crypto from 'crypto';
import { Construct } from 'constructs';
import { Duration as CDKDuration, CustomResource } from 'aws-cdk-lib';
import { SubnetType, Vpc, IVpc } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraCapacityUnit,
  AuroraMysqlEngineVersion,
  AuroraPostgresEngineVersion,
  DatabaseClusterEngine,
  DatabaseCluster,
  ClusterInstance,
  IDatabaseCluster,
  DatabaseClusterProps,
  Endpoint,
} from 'aws-cdk-lib/aws-rds';
import {
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Stack } from './Stack.js';
import { isCDKConstruct, getFunctionRef } from './Construct.js';
import { SSTConstruct } from './Construct.js';
import { Function as Fn } from './Function.js';
import { BindingProps } from './util/binding.js';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';

export interface RDSTv2Types {
  path: string;
  camelCase?: boolean;
}

export interface RDSv2CdkServerlessClusterProps
  extends Omit<
    DatabaseClusterProps,
    'vpc' | 'engine' | 'defaultDatabaseName' | 'scaling'
  > {
  vpc?: IVpc;
}

export interface RDSv2Props {
  engine:
    | 'mysql8.0'
    | 'postgresql13.15'
    | 'postgresql13.12'
    | 'postgresql13.9'
    | 'postgresql14.10'
    | 'postgresql15.5'
    | 'postgresql16.1';
  defaultDatabaseName: string;
  scaling?: {
    minCapacity?: keyof typeof AuroraCapacityUnit | number;
    maxCapacity?: keyof typeof AuroraCapacityUnit | number;
    secondsUntilAutoPause?: number;
  };
  migrations?: string;
  types?: string | RDSTv2Types;
  cdk?: {
    id?: string;
    cluster?: IDatabaseCluster | RDSv2CdkServerlessClusterProps;
    secret?: ISecret;
  };
}

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export class RDSv2 extends Construct implements SSTConstruct {
  readonly id: string;
  readonly cdk: {
    cluster: DatabaseCluster;
  };
  migratorFunction?: Fn;
  private props: RDSv2Props;
  private secret: ISecret;

  constructor(scope: Construct, id: string, props: RDSv2Props) {
    super(scope, props.cdk?.id || id);

    this.validateRequiredProps(props);
    this.id = id;
    this.props = props;
    this.cdk = {} as any;

    const { migrations, cdk } = props;

    if (cdk && isCDKConstruct(cdk.cluster)) {
      this.validateCDKPropWhenIsConstruct();
      this.cdk.cluster = this.importCluster();
      this.secret = cdk.secret!;
    } else {
      this.validateCDKPropWhenIsClusterProps();
      this.cdk.cluster = this.createCluster();
      this.secret = this.cdk.cluster.secret!;
    }

    if (migrations) {
      this.runMigrations(migrations);
    }

    const app = this.node.root as any;
    app.registerTypes(this);
  }

  get clusterArn(): string {
    return this.cdk.cluster.clusterArn;
  }

  get clusterIdentifier(): string {
    return this.cdk.cluster.clusterIdentifier;
  }

  get clusterEndpoint(): Endpoint {
    return this.cdk.cluster.clusterEndpoint;
  }

  get defaultDatabaseName(): string {
    return this.props.defaultDatabaseName;
  }

  get secretArn(): string {
    return this.secret.secretArn;
  }

  getConstructMetadata() {
    const { engine, defaultDatabaseName, types } = this.props;
    return {
      type: 'RDS',
      data: {
        engine,
        secretArn: this.secretArn,
        types: typeof types === 'string' ? { path: types } : types,
        clusterArn: this.clusterArn,
        clusterIdentifier: this.clusterIdentifier,
        defaultDatabaseName,
        migrator:
          this.migratorFunction && getFunctionRef(this.migratorFunction),
      },
    };
  }

  getBindings(): BindingProps {
    return {
      clientPackage: 'rds',
      variables: {
        clusterArn: { type: 'plain', value: this.clusterArn },
        secretArn: { type: 'plain', value: this.secretArn },
        defaultDatabaseName: { type: 'plain', value: this.defaultDatabaseName },
      },
      permissions: {
        'rds-data:*': [this.clusterArn],
        'secretsmanager:GetSecretValue': [
          this.secret.secretFullArn || `${this.secret.secretArn}*`,
        ],
        'secretsmanager:DescribeSecret': [
          this.secret.secretFullArn || `${this.secret.secretArn}*`,
        ],
        ...(this.secret.encryptionKey
          ? { 'kms:Decrypt': [this.secret.encryptionKey.keyArn] }
          : {}),
      },
    };
  }

  runMigrations(migrations: string, database?: string): void {
    this.validateMigrationsFileExists(migrations);
    this.createMigrationsFunction(migrations);
    this.createMigrationCustomResource(migrations, database);
  }

  private validateRequiredProps(props: RDSv2Props) {
    if (!props.engine) {
      throw new Error(`Missing "engine" in the "${this.node.id}" RDS`);
    }
    if (!props.defaultDatabaseName) {
      throw new Error(
        `Missing "defaultDatabaseName" in the "${this.node.id}" RDS`
      );
    }
  }

  private validateCDKPropWhenIsConstruct() {
    if (!this.props.cdk?.secret) {
      throw new Error(
        `Missing "cdk.secret" in the "${this.node.id}" RDS. You must provide a secret to import an existing RDS Serverless Cluster.`
      );
    }
  }

  private validateCDKPropWhenIsClusterProps() {
    const props = this.props.cdk?.cluster as any;
    if (props?.engine) throw new Error(`Use "engine" at the top level.`);
    if (props?.defaultDatabaseName)
      throw new Error(`Use "defaultDatabaseName" at the top level.`);
    if (props?.scaling) throw new Error(`Use "scaling" at the top level.`);
    if (props?.enableDataApi === false)
      throw new Error(`Data API must be enabled.`);
    if (props?.credentials?.password)
      throw new Error(`Only SecretManager credentials are supported.`);
  }

  private validateMigrationsFileExists(migrations: string) {
    if (!fs.existsSync(migrations)) {
      throw new Error(
        `Cannot find the migrations in "${path.resolve(migrations)}".`
      );
    }
  }

  private getEngine(engine: RDSv2Props['engine']) {
    const versions: Record<RDSv2Props['engine'], any> = {
      'mysql8.0': AuroraMysqlEngineVersion.VER_3_04_0,
      'postgresql13.15': AuroraPostgresEngineVersion.VER_13_15,
      'postgresql13.12': AuroraPostgresEngineVersion.VER_13_12,
      'postgresql13.9': AuroraPostgresEngineVersion.VER_13_9,
      'postgresql14.10': AuroraPostgresEngineVersion.VER_14_10,
      'postgresql15.5': AuroraPostgresEngineVersion.VER_15_5,
      'postgresql16.1': AuroraPostgresEngineVersion.VER_16_1,
    };
    return engine.includes('mysql')
      ? DatabaseClusterEngine.auroraMysql({ version: versions[engine] })
      : DatabaseClusterEngine.auroraPostgres({ version: versions[engine] });
  }

  private getScaling(scaling?: RDSv2Props['scaling']) {
    const max =
      typeof scaling?.maxCapacity === 'string'
        ? AuroraCapacityUnit[scaling.maxCapacity]
        : scaling?.maxCapacity;
    const min =
      typeof scaling?.minCapacity === 'string'
        ? AuroraCapacityUnit[scaling.minCapacity]
        : scaling?.minCapacity;
    if (scaling?.secondsUntilAutoPause && min !== 0) {
      throw new Error(
        `The "secondsUntilAutoPause" option requires min capacity of 0. Got min: ${min}`
      );
    }
    return {
      serverlessV2MinCapacity: min,
      serverlessV2MaxCapacity: max,
      serverlessV2SecondsUntilAutoPause: scaling?.secondsUntilAutoPause,
    };
  }

  private getVpc(props: RDSv2CdkServerlessClusterProps) {
    return props.vpc ?? new Vpc(this, 'vpc', { natGateways: 0 });
  }

  private getVpcSubnets(props: RDSv2CdkServerlessClusterProps) {
    return props.vpc
      ? props.vpcSubnets
      : { subnetType: SubnetType.PRIVATE_ISOLATED };
  }

  private createCluster(): DatabaseCluster {
    const { engine, defaultDatabaseName, scaling, cdk } = this.props;
    const app = this.node.root as any;
    const clusterProps = cdk?.cluster || {};
    const name = app.logicalPrefixedName(this.node.id);
    return new DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: name,
      ...clusterProps,
      defaultDatabaseName,
      enableDataApi: true,
      engine: this.getEngine(engine),
      writer: ClusterInstance.serverlessV2(`${name}-serverless-v2-writer`),
      ...this.getScaling(scaling),
      vpc: this.getVpc(clusterProps),
      vpcSubnets: this.getVpcSubnets(clusterProps),
    });
  }

  private importCluster(): DatabaseCluster {
    return this.props.cdk!.cluster as DatabaseCluster;
  }

  private createMigrationsFunction(migrations: string) {
    const { engine, defaultDatabaseName } = this.props;
    const app = this.node.root as any;
    const migrationsDestination = 'sst_rds_migration_scripts';

    this.migratorFunction = new Fn(this, 'MigrationFunction', {
      handler: path.resolve(
        path.join(__dirname, '../support/rds-migrator/index.handler')
      ),
      runtime: 'nodejs22.x',
      timeout: 900,
      memorySize: 1024,
      environment: {
        RDS_ARN: this.cdk.cluster.clusterArn,
        RDS_SECRET: this.cdk.cluster.secret!.secretArn,
        RDS_DATABASE: defaultDatabaseName,
        RDS_ENGINE_MODE: engine.includes('postgres') ? 'postgres' : 'mysql',
        RDS_MIGRATIONS_PATH:
          app.mode === 'dev' ? migrations : migrationsDestination,
      },
      permissions: [this.cdk.cluster],
      copyFiles: [{ from: migrations, to: migrationsDestination }],
      nodejs: {
        install: ['kysely', 'kysely-data-api'],
        format: 'esm',
      },
      _doNotAllowOthersToBind: true,
    });

    this.migratorFunction._overrideMetadataHandler =
      'rds-migrator/index.handler';
  }

  private createMigrationCustomResource(migrations: string, database?: string) {
    const app = this.node.root as any;

    const handler = new LambdaFunction(this, 'MigrationHandler', {
      code: Code.fromAsset(path.join(__dirname, '../support/script-function')),
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: CDKDuration.minutes(15),
      memorySize: 1024,
      initialPolicy: [
        new PolicyStatement({
          actions: ['cloudformation:DescribeStacks'],
          resources: [Stack.of(this).stackId],
        }),
      ],
    });

    this.migratorFunction?.grantInvoke(handler);

    const hash =
      app.mode === 'dev' ? 0 : this.generateMigrationsHash(migrations);

    const resource = new CustomResource(this, 'MigrationResource', {
      serviceToken: handler.functionArn,
      resourceType: 'Custom::SSTScript',
      properties: {
        UserCreateFunction:
          app.mode === 'dev' ? undefined : this.migratorFunction?.functionName,
        UserUpdateFunction:
          app.mode === 'dev' ? undefined : this.migratorFunction?.functionName,
        UserParams: JSON.stringify({ database }),
        MigrationsHash: hash,
      },
    });

    resource.node.addDependency(this.cdk.cluster);
  }

  private generateMigrationsHash(migrations: string): string {
    const files = globSync('**', {
      dot: true,
      nodir: true,
      follow: true,
      cwd: migrations,
      ignore: ['**/node_modules/**'],
    });

    return crypto
      .createHash('md5')
      .update(
        files
          .map((file) => fs.readFileSync(path.join(migrations, file)))
          .join('')
      )
      .digest('hex');
  }
}
