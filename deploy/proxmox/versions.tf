terraform {
  required_version = ">= 1.10"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.118"
    }
  }

  # The state is committed to the repo, encrypted client-side (OpenTofu).
  # The passphrase lives only in ~/.config/learnharness/proxmox.env
  # (TF_VAR_state_passphrase) — without it the state cannot be read.
  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.passphrase
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

# Endpoint and API token come from the environment (PROXMOX_VE_ENDPOINT,
# PROXMOX_VE_API_TOKEN, PROXMOX_VE_INSECURE) — see tofu.sh.
provider "proxmox" {}
