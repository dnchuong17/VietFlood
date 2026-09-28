pipeline {
  agent any

  options {
    skipDefaultCheckout()
    disableConcurrentBuilds()
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '10'))
  }

  environment {
    BE_DIR = '/home/project/vietflood'
    REPO_URL = 'https://github.com/dnchuong17/VietFlood.git'
    IMAGE_NAME = 'vietflood-be'
    CONTAINER_NAME = 'vietflood-be-container'
    HOST_PORT = '3004'
    CONTAINER_PORT = '8081'
    ENV_FILE = '/opt/env/vietflood.env'
    DOCKER_NETWORK = 'jenkins_default'
    REDIS_CONTAINER_NAME = 'vietflood-redis'
    RABBITMQ_CONTAINER_NAME = 'vietflood-rabbitmq'
    RABBITMQ_DEFAULT_USER = 'admin'
    RABBITMQ_DEFAULT_PASS = 'admin'
  }

  stages {
    stage('Init') {
      steps {
        script {
          env.TIMESTAMP = sh(script: 'TZ="Asia/Ho_Chi_Minh" date +"%Y%m%d-%H%M%S"', returnStdout: true).trim()
          env.READABLE_TIME = sh(script: 'TZ="Asia/Ho_Chi_Minh" date +"%Y-%m-%d %H:%M:%S"', returnStdout: true).trim()
        }
      }
    }

    stage('Prepare Folder') {
      steps {
        sh '''
          rm -rf "$BE_DIR"
          mkdir -p "$BE_DIR"
        '''
      }
    }

    stage('Clone Source Code') {
      steps {
        sh '''
          echo "Cloning VietFlood repo..."
          git clone "$REPO_URL" "$BE_DIR"
        '''
      }
    }

    stage('Build Docker Image') {
      steps {
        dir("${env.BE_DIR}") {
          sh 'docker build -t ${IMAGE_NAME}:${TIMESTAMP} -t ${IMAGE_NAME}:latest .'
        }
      }
    }

    stage('Stop & Remove Old Container') {
      steps {
        sh '''
          docker stop "$CONTAINER_NAME" || true
          docker rm "$CONTAINER_NAME" || true
        '''
      }
    }

    stage('Start Runtime Dependencies') {
      steps {
        sh '''
          set -eu

          if [ ! -f "$ENV_FILE" ]; then
            echo "Missing env file: $ENV_FILE"
            exit 1
          fi

          set -a
          . "$ENV_FILE"
          set +a

          : "${REDIS_PASSWORD:?Missing REDIS_PASSWORD in $ENV_FILE}"
          RABBITMQ_DEFAULT_USER="${RABBITMQ_DEFAULT_USER:-admin}"
          RABBITMQ_DEFAULT_PASS="${RABBITMQ_DEFAULT_PASS:-admin}"
          export RABBITMQ_DEFAULT_USER RABBITMQ_DEFAULT_PASS

          docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1 || docker network create "$DOCKER_NETWORK"

          if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER_NAME"; then
            docker start "$REDIS_CONTAINER_NAME" >/dev/null
            docker network connect --alias redis "$DOCKER_NETWORK" "$REDIS_CONTAINER_NAME" 2>/dev/null || true
          else
            docker run -d \
              --name "$REDIS_CONTAINER_NAME" \
              --network "$DOCKER_NETWORK" \
              --network-alias redis \
              --restart unless-stopped \
              redis:7-alpine \
              redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes
          fi

          if docker ps -a --format '{{.Names}}' | grep -qx "$RABBITMQ_CONTAINER_NAME"; then
            docker start "$RABBITMQ_CONTAINER_NAME" >/dev/null
            docker network connect --alias rabbitmq "$DOCKER_NETWORK" "$RABBITMQ_CONTAINER_NAME" 2>/dev/null || true
          else
            docker run -d \
              --name "$RABBITMQ_CONTAINER_NAME" \
              --network "$DOCKER_NETWORK" \
              --network-alias rabbitmq \
              --restart unless-stopped \
              --env RABBITMQ_DEFAULT_USER \
              --env RABBITMQ_DEFAULT_PASS \
              rabbitmq:3-management-alpine
          fi

          echo "Waiting for Redis..."
          for i in $(seq 1 30); do
            if docker exec "$REDIS_CONTAINER_NAME" redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1; then
              break
            fi
            sleep 2
            if [ "$i" = "30" ]; then
              echo "Redis is not ready"
              exit 1
            fi
          done

          echo "Waiting for RabbitMQ..."
          for i in $(seq 1 60); do
            if docker exec "$RABBITMQ_CONTAINER_NAME" rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
              break
            fi
            sleep 2
            if [ "$i" = "60" ]; then
              echo "RabbitMQ is not ready"
              exit 1
            fi
          done
        '''
      }
    }

    stage('Check Host Port') {
      steps {
        sh '''
          if docker ps --format '{{.Names}} {{.Ports}}' | grep -q "0.0.0.0:${HOST_PORT}->"; then
            echo "Host port ${HOST_PORT} is already in use:"
            docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | grep "0.0.0.0:${HOST_PORT}->" || true
            exit 1
          fi
        '''
      }
    }

    stage('Run New Container') {
      steps {
        script {
          def dockerRunArgs = [
            '-d',
            "--name ${env.CONTAINER_NAME}",
            "--network ${env.DOCKER_NETWORK}",
            "-p ${env.HOST_PORT}:${env.CONTAINER_PORT}",
            '--restart unless-stopped',
            "--env-file ${env.ENV_FILE}",
            "-e API_GATEWAY_PORT=${env.CONTAINER_PORT}",
            '-e REDIS_HOST=redis',
            '-e REDIS_PORT=6379',
            '-e REDIS_DB=0',
            "-e RABBITMQ_URL=amqp://${env.RABBITMQ_DEFAULT_USER}:${env.RABBITMQ_DEFAULT_PASS}@rabbitmq:5672"
          ]

          dockerRunArgs.add("${env.IMAGE_NAME}:${env.TIMESTAMP}")

          sh "docker run ${dockerRunArgs.join(' ')}"
        }
      }
    }
  }

  post {
    success {
      echo "VietFlood deployed: ${IMAGE_NAME}:${TIMESTAMP} at ${READABLE_TIME}"
    }
    failure {
      echo "VietFlood deployment failed: ${IMAGE_NAME}:${TIMESTAMP} at ${READABLE_TIME}"
    }
  }
}
