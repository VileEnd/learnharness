output "ipv4" {
  description = "The VM's IPv4 addresses as reported by the guest agent."
  value       = flatten(proxmox_virtual_environment_vm.learnharness.ipv4_addresses)
}

output "mac" {
  description = "The VM's MAC address (for a DHCP reservation)."
  value       = proxmox_virtual_environment_vm.learnharness.mac_addresses
}
