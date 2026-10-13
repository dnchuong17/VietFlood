pipeline {
  agent any

  options {
    skipDefaultCheckout()
    disableConcurrentBuilds()
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '10'))
  }

  environment {
    IMAGE_NAME = 'vietflood-be'
    CONTAINER_NAME = 'vietflood-be-container'
    HOST_PORT = '3004'
    CONTAINER_PORT = '8081'
    ENV_FILE = '/opt/env/vietflood.env'
    DOCKER_NETWORK = 'jenkins_default'
    REDIS_CONTAINER_NAME = 'vietflood-redis'
    RABBITMQ_CONTAINER_NAME = 'vietflood-rabbitmq'
    OLLAMA_CONTAINER_NAME = 'vietflood-ollama'
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

    stage('Checkout Source Code') {
      steps {
        deleteDir()
        checkout scm
      }
    }

    stage('Build Docker Image') {
      steps {
        sh 'docker build -t ${IMAGE_NAME}:${TIMESTAMP} -t ${IMAGE_NAME}:latest .'
      }
    }

    stage('Start Runtime Dependencies') {
      steps {
        sh '''
          set +x
          set -eu

          if [ ! -f "$ENV_FILE" ]; then
            echo "Missing env file: $ENV_FILE"
            exit 1
          fi

          set -a
          . "$ENV_FILE"
          set +a

          : "${REDIS_PASSWORD:?Missing REDIS_PASSWORD in $ENV_FILE}"
          : "${RABBITMQ_DEFAULT_USER:?Missing RABBITMQ_DEFAULT_USER in $ENV_FILE}"
          : "${RABBITMQ_DEFAULT_PASS:?Missing RABBITMQ_DEFAULT_PASS in $ENV_FILE}"
          : "${DATABASE_URL:?Missing DATABASE_URL in $ENV_FILE}"
          : "${CHAT_KEYRING_B64:?Missing CHAT_KEYRING_B64 in $ENV_FILE}"
          : "${CHAT_KEY_CURRENT:?Missing CHAT_KEY_CURRENT in $ENV_FILE}"
          : "${CHAT_DB_CA_BASE64:?Missing CHAT_DB_CA_BASE64 in $ENV_FILE}"
          : "${CHAT_BACKUP_RETENTION_DAYS:?Record the verified Supabase backup retention in $ENV_FILE}"
          : "${CHAT_BACKUP_VERIFIED_AT:?Record the backup verification date in $ENV_FILE}"

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

          echo "Checking Redis..."
          for i in $(seq 1 30); do
            redis_reply=$(docker exec "$REDIS_CONTAINER_NAME" redis-cli --no-auth-warning -a "$REDIS_PASSWORD" ping 2>&1 || true)
            if [ "$redis_reply" = "PONG" ]; then
              break
            fi

            case "$redis_reply" in
              *WRONGPASS*|*NOAUTH*|*'AUTH failed'*)
                echo "Redis authentication failed. The existing container may use a different password than $ENV_FILE. Preserve its data and reconcile the password before rerunning."
                exit 1
                ;;
            esac

            if [ "$i" = "30" ]; then
              redis_state=$(docker inspect -f '{{.State.Status}}' "$REDIS_CONTAINER_NAME" 2>/dev/null || true)
              echo "Redis did not become ready (container state: ${redis_state:-unknown}). Check the container logs and Docker access."
              exit 1
            fi
            sleep 2
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
          if ! docker exec "$RABBITMQ_CONTAINER_NAME" rabbitmqctl authenticate_user "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS" >/dev/null 2>&1; then
            echo "RabbitMQ authentication failed. Check that the existing container matches $ENV_FILE."
            exit 1
          fi
        '''
      }
    }

    stage('Prepare Ollama and Check RAG') {
      options { timeout(time: 20, unit: 'MINUTES') }
      steps {
        sh '''
          set +x
          set -eu
          set -a
          . "$ENV_FILE"
          set +a
          export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
          export OLLAMA_CHAT_MODEL="${OLLAMA_CHAT_MODEL:-qwen3:1.7b-q4_K_M}"
          export OLLAMA_REQUEST_TIMEOUT_MS="${OLLAMA_REQUEST_TIMEOUT_MS:-120000}"
          export OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-16384}"
          export RAG_REQUEST_TIMEOUT_MS="${RAG_REQUEST_TIMEOUT_MS:-300000}"
          export RAG_RETRIEVAL_TIMEOUT_MS="${RAG_RETRIEVAL_TIMEOUT_MS:-90000}"
          : "${RAG_SERVICE_URL:?Missing RAG_SERVICE_URL in $ENV_FILE}"
          : "${RAG_SERVICE_TOKEN:?Missing RAG_SERVICE_TOKEN in $ENV_FILE}"

          if [ "$OLLAMA_BASE_URL" = "http://ollama:11434" ]; then
            if docker container inspect "$OLLAMA_CONTAINER_NAME" >/dev/null 2>&1; then
              docker start "$OLLAMA_CONTAINER_NAME" >/dev/null
              docker network connect --alias ollama "$DOCKER_NETWORK" "$OLLAMA_CONTAINER_NAME" 2>/dev/null || true
            else
              docker run -d --name "$OLLAMA_CONTAINER_NAME" \
                --network "$DOCKER_NETWORK" --network-alias ollama \
                --restart unless-stopped \
                -v vietflood_ollama_models:/root/.ollama \
                -e OLLAMA_HOST=0.0.0.0:11434 -e OLLAMA_KEEP_ALIVE=10m \
                -e OLLAMA_NUM_PARALLEL=1 \
                "${OLLAMA_IMAGE:-ollama/ollama:latest}"
            fi
            for i in $(seq 1 60); do
              if docker exec "$OLLAMA_CONTAINER_NAME" ollama list >/dev/null 2>&1; then
                break
              fi
              if [ "$i" = "60" ]; then
                echo "Ollama did not become ready; check vietflood-ollama logs in Portainer."
                exit 1
              fi
              sleep 2
            done
            docker exec "$OLLAMA_CONTAINER_NAME" ollama pull "$OLLAMA_CHAT_MODEL"
          fi

          # Fail before stopping the running backend if a dependency is unavailable.
          docker run --rm --network "$DOCKER_NETWORK" --env-file "$ENV_FILE" \
            -e OLLAMA_BASE_URL -e OLLAMA_CHAT_MODEL -e OLLAMA_REQUEST_TIMEOUT_MS \
            -e OLLAMA_NUM_CTX -e RAG_REQUEST_TIMEOUT_MS -e RAG_RETRIEVAL_TIMEOUT_MS \
            --entrypoint node "$IMAGE_NAME:$TIMESTAMP" /app/scripts/check-chat-runtime.js
        '''
      }
    }

    stage('Migrate Chat History') {
      steps {
        sh '''
          set +x
          set -eu
          docker run --rm \
            --network "$DOCKER_NETWORK" \
            --env-file "$ENV_FILE" \
            --entrypoint node \
            "$IMAGE_NAME:$TIMESTAMP" \
            /app/scripts/migrate-chat-history.js
        '''
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
        sh '''
          set +x
          set -eu
          set -a
          . "$ENV_FILE"
          set +a
          : "${RABBITMQ_DEFAULT_USER:?Missing RABBITMQ_DEFAULT_USER in $ENV_FILE}"
          : "${RABBITMQ_DEFAULT_PASS:?Missing RABBITMQ_DEFAULT_PASS in $ENV_FILE}"
          : "${CHAT_KEYRING_B64:?Missing CHAT_KEYRING_B64 in $ENV_FILE}"
          : "${CHAT_KEY_CURRENT:?Missing CHAT_KEY_CURRENT in $ENV_FILE}"
          : "${CHAT_DB_CA_BASE64:?Missing CHAT_DB_CA_BASE64 in $ENV_FILE}"
          RABBITMQ_URL="amqp://${RABBITMQ_DEFAULT_USER}:${RABBITMQ_DEFAULT_PASS}@rabbitmq:5672"
          export RABBITMQ_URL
          export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://ollama:11434}"
          export OLLAMA_CHAT_MODEL="${OLLAMA_CHAT_MODEL:-qwen3:1.7b-q4_K_M}"
          export OLLAMA_REQUEST_TIMEOUT_MS="${OLLAMA_REQUEST_TIMEOUT_MS:-120000}"
          export OLLAMA_NUM_CTX="${OLLAMA_NUM_CTX:-16384}"
          export RAG_REQUEST_TIMEOUT_MS="${RAG_REQUEST_TIMEOUT_MS:-300000}"
          export RAG_RETRIEVAL_TIMEOUT_MS="${RAG_RETRIEVAL_TIMEOUT_MS:-90000}"

          docker run -d \
            --name "$CONTAINER_NAME" \
            --network "$DOCKER_NETWORK" \
            -p "$HOST_PORT:$CONTAINER_PORT" \
            --restart unless-stopped \
            --env-file "$ENV_FILE" \
            -e API_GATEWAY_PORT="$CONTAINER_PORT" \
            -e REDIS_HOST=redis \
            -e REDIS_PORT=6379 \
            -e REDIS_DB=0 \
            -e RABBITMQ_URL \
            -e OLLAMA_BASE_URL -e OLLAMA_CHAT_MODEL \
            -e OLLAMA_REQUEST_TIMEOUT_MS -e OLLAMA_NUM_CTX -e RAG_REQUEST_TIMEOUT_MS -e RAG_RETRIEVAL_TIMEOUT_MS \
            "$IMAGE_NAME:$TIMESTAMP"
        '''
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
