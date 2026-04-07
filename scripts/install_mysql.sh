#!/bin/bash

# OptiNode MySQL Setup Script for Ubuntu
# Instala MySQL Server e phpMyAdmin automaticamente

echo "--- Iniciando Instalação do MySQL e phpMyAdmin ---"

# Atualizar repositórios
sudo apt-get update

# Instalar MySQL Server (não interativo)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server

# Instalar phpMyAdmin (configuração básica para Apache)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y phpmyadmin

# Habilitar o módulo do phpMyAdmin no Apache
sudo ln -s /etc/phpmyadmin/apache.conf /etc/apache2/conf-available/phpmyadmin.conf
sudo a2enconf phpmyadmin
sudo systemctl restart apache2

# Configurar o MySQL para permitir login root sem senha inicialmente (ajuste se necessário)
sudo mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY ''; FLUSH PRIVILEGES;"

echo "--- Instalação Concluída ---"
echo "Acesse o OptiNode para aplicar a configuração da porta 3165."
