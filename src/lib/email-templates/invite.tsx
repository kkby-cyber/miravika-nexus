import * as React from 'react'

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Text,
} from '@react-email/components'
import * as brand from './brand'

interface InviteEmailProps {
  siteName: string
  siteUrl: string
  confirmationUrl: string
}

export const InviteEmail = ({
  siteName,
  siteUrl,
  confirmationUrl,
}: InviteEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>You've been invited to join {siteName}</Preview>
    <Body style={brand.main}>
      <Container style={brand.container}>
        <Text style={brand.brandMark}>MIRAVIKA</Text>
        <Text style={brand.brandTagline}>Luxury Redefined</Text>
        <Hr style={brand.divider} />
        <Heading style={brand.h1}>You've been invited</Heading>
        <Text style={brand.text}>
          You've been invited to join{' '}
          <Link href={siteUrl} style={brand.link}>
            <strong>{siteName}</strong>
          </Link>
          . Select the button below to accept the invitation and create your
          account.
        </Text>
        <Button style={brand.button} href={confirmationUrl}>
          Accept Invitation
        </Button>
        <Text style={brand.footer}>
          If you weren't expecting this invitation, you can safely ignore this
          email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default InviteEmail
