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
            "-e API_GATEWAY_PORT=${env.CONTAINER_PORT}"
          ]

          if (env.DATABASE_URL && env.DATABASE_URL.trim()) {
            dockerRunArgs.add("-e DATABASE_URL=${env.DATABASE_URL}")
          }
          if (env.REDIS_HOST && env.REDIS_HOST.trim()) {
            dockerRunArgs.add("-e REDIS_HOST=${env.REDIS_HOST}")
          }
          if (env.REDIS_PORT && env.REDIS_PORT.trim()) {
            dockerRunArgs.add("-e REDIS_PORT=${env.REDIS_PORT}")
          }
          if (env.REDIS_PASSWORD && env.REDIS_PASSWORD.trim()) {
            dockerRunArgs.add("-e REDIS_PASSWORD=${env.REDIS_PASSWORD}")
          }
          if (env.RABBITMQ_URL && env.RABBITMQ_URL.trim()) {
            dockerRunArgs.add("-e RABBITMQ_URL=${env.RABBITMQ_URL}")
          }
          if (env.JWT_SECRET && env.JWT_SECRET.trim()) {
            dockerRunArgs.add("-e JWT_SECRET=${env.JWT_SECRET}")
          }
          if (env.REFRESH_SECRET && env.REFRESH_SECRET.trim()) {
            dockerRunArgs.add("-e REFRESH_SECRET=${env.REFRESH_SECRET}")
          }

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
